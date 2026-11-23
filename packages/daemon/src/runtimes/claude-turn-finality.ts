import type { AgentCompleteEvent, RuntimeEvent } from '@autopod/shared';
import type { Logger } from 'pino';
import { resolveStuckRunningThresholdMs } from '../util/stuck-running-threshold.js';
import type { ClaudeStreamEvent } from './claude-stream-parser.js';

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pending non-ambient background work of one Claude CLI process, derived from
 * its stream-json task lifecycle frames:
 *
 * - `system/task_started` / `task_notification` edge bookends,
 * - `system/task_updated` (a foreground command moved to the background, or a
 *   terminal status),
 * - `system/background_tasks_changed`, the authoritative level signal (full set,
 *   REPLACE semantics, empty at process start).
 *
 * Ambient/housekeeping tasks (`ambient`, `skip_transcript`) are not agent work
 * and never count as pending. CLIs that emit none of these frames leave the set
 * empty, which preserves the pre-#648 behaviour.
 */
export class ClaudeBackgroundTasks {
  private readonly pending = new Set<string>();
  private readonly ambient = new Set<string>();

  get size(): number {
    return this.pending.size;
  }

  /** Returns true when the pending set changed. */
  observe(raw: ClaudeStreamEvent): boolean {
    if (!isObject(raw) || raw.type !== 'system') return false;
    const before = this.key();
    switch (raw.subtype) {
      case 'task_started': {
        const id = stringField(raw.task_id);
        if (!id) break;
        if (raw.ambient === true || raw.skip_transcript === true) {
          this.ambient.add(id);
          break;
        }
        // A foreground task blocks its tool call; it only becomes pending work
        // once `task_updated` reports it moved to the background.
        if (raw.is_backgrounded !== false) this.pending.add(id);
        break;
      }
      case 'task_updated': {
        const id = stringField(raw.task_id);
        const patch = raw.patch;
        if (!id || !isObject(patch)) break;
        if (typeof patch.status === 'string' && TERMINAL_TASK_STATUSES.has(patch.status)) {
          this.pending.delete(id);
          break;
        }
        if (patch.is_backgrounded === true && !this.ambient.has(id)) this.pending.add(id);
        break;
      }
      case 'task_notification': {
        const id = stringField(raw.task_id);
        if (!id) break;
        this.pending.delete(id);
        break;
      }
      case 'background_tasks_changed': {
        if (!Array.isArray(raw.tasks)) break;
        this.pending.clear();
        for (const task of raw.tasks) {
          if (!isObject(task)) continue;
          const id = stringField(task.task_id);
          if (!id) continue;
          if (task.ambient === true || this.ambient.has(id)) continue;
          this.pending.add(id);
        }
        break;
      }
      default:
        return false;
    }
    return this.key() !== before;
  }

  private key(): string {
    return [...this.pending].sort().join('\u0000');
  }
}

const DEFAULT_GRACE_MS = 30_000;
/** Long suites legitimately take 20–30 min and Claude's Bash timeout pushes them to the background. */
export const DEFAULT_CLAUDE_BACKGROUND_WAIT_MS = 25 * 60 * 1_000;
/**
 * Headroom kept between the background wait and the stuck-pod watchdog: after the
 * wait expires the daemon still needs the exit wait and a verified tree kill
 * (≤ ~65 s) before the run settles.
 */
export const BACKGROUND_WAIT_WATCHDOG_MARGIN_MS = 3 * 60 * 1_000;

function positiveNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveClaudeGraceMs(env: Record<string, string | undefined> = process.env) {
  return positiveNumber(env.AUTOPOD_POST_COMPLETE_GRACE_MS) ?? DEFAULT_GRACE_MS;
}

/**
 * Effective bounded wait for background work (`AUTOPOD_CLAUDE_BACKGROUND_WAIT_MS`),
 * clamped below the stuck-pod watchdog so the watchdog can never fail a pod
 * during an intentional wait, whatever either setting is.
 */
export function resolveClaudeBackgroundWaitMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const requested =
    positiveNumber(env.AUTOPOD_CLAUDE_BACKGROUND_WAIT_MS) ?? DEFAULT_CLAUDE_BACKGROUND_WAIT_MS;
  const ceiling = resolveStuckRunningThresholdMs(env) - BACKGROUND_WAIT_WATCHDOG_MARGIN_MS;
  return Math.max(0, Math.min(requested, ceiling));
}

interface ClosableStream {
  end?: () => void;
  destroy?: (error?: Error) => void;
  destroyed?: boolean;
}

export interface ClaudeTurnFinalityOptions {
  podId: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  /** Streams force-closed when a held result's window expires (stdout, stderr). */
  streams: ClosableStream[];
  graceMs?: number;
  backgroundWaitMs?: number;
  /**
   * Whether a result written with background work pending may wait for it. False
   * while the pod awaits a human (a retained run would only queue the reply).
   */
  awaitBackground?: () => boolean;
}

export type ClaudeTurnVerdict =
  /** No result was produced (startup failure, provider error, external kill mid-turn). */
  | { kind: 'none' }
  /** The last result stood: no further turn activity and no pending background wait. */
  | { kind: 'final' }
  /** A result was followed by more turn activity and no later result. */
  | { kind: 'active' }
  /** The turn ended waiting on background work and Claude never continued. */
  | {
      kind: 'background_pending';
      pendingTasks: number;
      /** `cap`: the bounded wait expired; `exited`: the process ended first. */
      reason: 'cap' | 'exited';
      waitMs: number;
    }
  /** The awaited background work finished, but no new turn started within the grace. */
  | { kind: 'background_unresumed'; pendingTasks: number };

type CloseReason = 'grace' | 'background_cap' | 'background_unresumed' | 'fatal';

const CONTINUATION_NOTICE =
  'Claude kept working in the same session after an intermediate result; that result was not treated as the end of the turn.';

function isReportTaskSummary(tool: string): boolean {
  return tool === 'report_task_summary' || tool.endsWith('__report_task_summary');
}

/** A frame that belongs to a (new) model turn, proving the held result was not final. */
function isTurnFrame(raw: ClaudeStreamEvent): boolean {
  return (
    raw.type === 'assistant' ||
    raw.type === 'user' ||
    raw.type === 'result' ||
    (raw.type === 'system' && raw.subtype === 'init')
  );
}

/**
 * Claude-only turn finality (#648).
 *
 * One `claude -p` process can write several `result` frames: it waits for
 * background tasks and continues in the same session when they notify, and a
 * resumed session can settle leftover work before the new prompt. A `result` is
 * therefore *held* rather than forwarded:
 *
 * - more turn frames after it → it was intermediate: no kill, and a status
 *   notice is emitted. Result usage is forwarded independently of finality;
 * - pending non-ambient background work, no `report_task_summary` in this
 *   invocation and `awaitBackground()` → bounded wait for the CLI to continue;
 *   when the work drains, the CLI gets one grace window to start the next turn;
 * - otherwise → the grace window (as before), or EOF.
 *
 * A window expiry force-closes the streams like `withPostCompleteGrace`; the
 * caller then verifies termination and classifies the run with `verdict()`.
 */
export function createClaudeTurnFinality(options: ClaudeTurnFinalityOptions) {
  const graceMs = options.graceMs ?? resolveClaudeGraceMs();
  const backgroundWaitMs = options.backgroundWaitMs ?? resolveClaudeBackgroundWaitMs();
  const tasks = new ClaudeBackgroundTasks();
  let held: AgentCompleteEvent | null = null;
  let heldForBackground = false;
  let heldPendingTasks = 0;
  let continued = false;
  let continuationNotice = false;
  let reported = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closedBy: CloseReason | null = null;
  let verdict: ClaudeTurnVerdict = { kind: 'none' };

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const arm = (ms: number, reason: CloseReason) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      closedBy = reason;
      options.logger.warn(
        { component: 'claude-runtime', podId: options.podId, reason, windowMs: ms },
        'Claude turn window expired — force-closing agent streams',
      );
      for (const stream of options.streams) {
        if (stream.destroyed) continue;
        try {
          if (typeof stream.end === 'function') stream.end();
          else stream.destroy?.();
        } catch {
          // Best-effort; termination is verified by the caller.
        }
      }
    }, ms);
    timer.unref?.();
  };

  const awaitBackground = () => {
    try {
      return options.awaitBackground?.() ?? true;
    } catch {
      return false;
    }
  };

  const hold = (event: AgentCompleteEvent) => {
    held = event;
    closedBy = null;
    heldPendingTasks = tasks.size;
    heldForBackground =
      heldPendingTasks > 0 && !reported && backgroundWaitMs > graceMs && awaitBackground();
    if (heldForBackground) {
      options.logger.info(
        {
          component: 'claude-runtime',
          podId: options.podId,
          pendingTasks: heldPendingTasks,
          backgroundWaitMs,
        },
        'Claude ended its turn with background work pending — waiting for it to continue',
      );
      arm(backgroundWaitMs, 'background_cap');
    } else arm(graceMs, 'grace');
  };

  function observeRaw(raw: ClaudeStreamEvent): void {
    if (typeof raw !== 'object' || raw === null) return;
    const changed = tasks.observe(raw);
    if (held && isTurnFrame(raw)) {
      // The session continued: the held result was intermediate.
      continued = true;
      held = null;
      heldForBackground = false;
      clearTimer();
      continuationNotice = true;
      return;
    }
    if (changed && held && heldForBackground && tasks.size === 0) {
      // The awaited work finished; the CLI should now start the next turn.
      arm(graceMs, 'background_unresumed');
    }
  }

  async function* wrap(source: AsyncIterable<RuntimeEvent>): AsyncIterable<RuntimeEvent> {
    try {
      for await (const event of source) {
        if (continuationNotice) {
          continuationNotice = false;
          yield {
            type: 'status',
            timestamp: new Date().toISOString(),
            message: CONTINUATION_NOTICE,
          };
        }
        if (event.type === 'complete') {
          hold(event);
          continue;
        }
        if (event.type === 'tool_use' && isReportTaskSummary(event.tool)) reported = true;
        if (event.type === 'error' && event.fatal && !timer) arm(graceMs, 'fatal');
        yield event;
      }
      clearTimer();
      const final = held as AgentCompleteEvent | null;
      if (final) {
        if (heldForBackground)
          verdict =
            closedBy === 'background_unresumed'
              ? { kind: 'background_unresumed', pendingTasks: heldPendingTasks }
              : {
                  kind: 'background_pending',
                  pendingTasks: heldPendingTasks,
                  reason: closedBy === 'background_cap' ? 'cap' : 'exited',
                  waitMs: backgroundWaitMs,
                };
        else verdict = { kind: 'final' };
        held = null;
        // Only a finished turn may settle completion, validation or a soft budget pause.
        if (verdict.kind === 'final') yield final;
      } else if (continued) {
        verdict = { kind: 'active' };
      }
    } finally {
      clearTimer();
    }
  }

  return {
    observeRaw,
    wrap,
    verdict: (): ClaudeTurnVerdict => verdict,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Operator-facing description of an unfinished turn, or null when the turn finished. */
export function describeInterruptedClaudeTurn(
  verdict: ClaudeTurnVerdict,
  exitCode: number,
  podId: string,
): string | null {
  let cause: string;
  switch (verdict.kind) {
    case 'background_pending':
      cause =
        verdict.reason === 'cap'
          ? `Claude ended its turn while ${plural(verdict.pendingTasks, 'background task')} ${verdict.pendingTasks === 1 ? 'was' : 'were'} still running and did not continue within ${Math.round(verdict.waitMs / 60_000)} min; the daemon stopped it (exit code ${exitCode}).`
          : `Claude ended its turn while ${plural(verdict.pendingTasks, 'background task')} ${verdict.pendingTasks === 1 ? 'was' : 'were'} still running, and the process exited (code ${exitCode}) before it continued.`;
      break;
    case 'background_unresumed':
      cause = `Claude ended its turn waiting on ${plural(verdict.pendingTasks, 'background task')}; the work finished but Claude did not continue, so the daemon stopped it (exit code ${exitCode}).`;
      break;
    case 'active':
      cause = `Claude stopped (exit code ${exitCode}) while still working after an intermediate result, without finishing its turn.`;
      break;
    default:
      return null;
  }
  return `${cause} The turn is incomplete: the workspace may hold unfinished edits and was not validated. Run \`ap rework ${podId}\` to continue from the preserved worktree.`;
}
