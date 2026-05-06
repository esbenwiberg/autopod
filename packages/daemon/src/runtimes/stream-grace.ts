import type { AgentEvent } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';

const DEFAULT_GRACE_MS = 30_000;
const DEFAULT_EXIT_CODE_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_PROBE_MS = 600_000; // 10 min — short enough to detect wedges, long enough not to false-positive on hard thinking
const DEFAULT_IDLE_PROBE_TIMEOUT_MS = 10_000;

interface DestroyableStream {
  /**
   * Writable-side end signal. Present on Duplex/PassThrough — the streams we
   * actually use (Dockerode's demuxed PassThroughs). Preferred over `destroy`
   * because Node's readline async iterator only ends on `end`, not on `close`
   * — calling `.destroy()` alone leaves the consumer's for-await hanging.
   */
  end?: () => void;
  destroy?: (error?: Error) => void;
  destroyed?: boolean;
}

export interface PostCompleteGraceOptions {
  /** Streams to force-close when the grace timer fires. Pass stdout (and optionally stderr). */
  streams: DestroyableStream[];
  /** Component tag for log lines (e.g. `'claude-runtime'`). */
  runtimeName: string;
  podId: string;
  logger: Logger;
  /**
   * Override grace window. Falls back to `AUTOPOD_POST_COMPLETE_GRACE_MS` env,
   * then `DEFAULT_GRACE_MS`.
   */
  gracePeriodMs?: number;
}

/**
 * Wrap an agent-event stream so that once a `complete` (or fatal `error`) event
 * passes through, a one-shot timer is armed that force-closes the underlying
 * streams if they haven't naturally EOF'd within the grace window.
 *
 * Without this, a wedged container's stdout can never close — leaving the
 * runtime's `for await` blocked indefinitely on a pod the agent has already
 * finished. The grace timer is the safety net that lets pod-manager reach
 * `handleCompletion` even when Docker (or the agent process) won't cooperate.
 */
export async function* withPostCompleteGrace(
  source: AsyncIterable<AgentEvent>,
  options: PostCompleteGraceOptions,
): AsyncIterable<AgentEvent> {
  const gracePeriodMs = resolveGracePeriodMs(options.gracePeriodMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let armed = false;

  const armGraceTimer = () => {
    if (armed) return;
    armed = true;
    timer = setTimeout(() => {
      options.logger.warn(
        {
          component: options.runtimeName,
          podId: options.podId,
          gracePeriodMs,
        },
        'Post-complete grace expired — force-closing agent streams',
      );
      for (const s of options.streams) {
        if (s.destroyed) continue;
        try {
          // Prefer `.end()` when available — that's what makes readline's
          // async iterator terminate. `.destroy()` alone emits `close` but
          // not `end`, leaving consumer for-awaits hung.
          if (typeof s.end === 'function') {
            s.end();
          } else if (typeof s.destroy === 'function') {
            s.destroy();
          }
        } catch {
          // Best-effort — failures here aren't actionable
        }
      }
    }, gracePeriodMs);
    // Don't keep the event loop alive solely to destroy a stream that may
    // already be unreachable.
    timer.unref?.();
  };

  try {
    for await (const event of source) {
      yield event;
      if (event.type === 'complete' || (event.type === 'error' && event.fatal)) {
        armGraceTimer();
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TIMEOUT_SENTINEL = Object.freeze({ kind: 'exit-code-timeout' as const });
type TimeoutSentinel = typeof TIMEOUT_SENTINEL;

export interface BoundedExitCodeOptions {
  runtimeName: string;
  podId: string;
  logger: Logger;
  /**
   * Override timeout. Falls back to `AUTOPOD_EXIT_CODE_TIMEOUT_MS` env,
   * then `DEFAULT_EXIT_CODE_TIMEOUT_MS`.
   */
  timeoutMs?: number;
}

export interface BoundedExitCodeResult {
  /** The resolved exit code, or null on timeout. */
  code: number | null;
  /** True if the wait timed out before the exit code resolved. */
  timedOut: boolean;
}

/**
 * Await a process exit code with a hard ceiling. Returns `{ timedOut: true }`
 * if the underlying promise hasn't resolved by the cutoff. Lets callers continue
 * cleanly when the container runtime layer is wedged and `inspect` won't return.
 */
export async function awaitExitCodeBounded(
  exitCodePromise: Promise<number>,
  options: BoundedExitCodeOptions,
): Promise<BoundedExitCodeResult> {
  const timeoutMs = resolveExitCodeTimeoutMs(options.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<TimeoutSentinel>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    timer.unref?.();
  });

  try {
    const result = await Promise.race<number | TimeoutSentinel>([exitCodePromise, timeoutPromise]);
    if (result === TIMEOUT_SENTINEL) {
      options.logger.warn(
        {
          component: options.runtimeName,
          podId: options.podId,
          timeoutMs,
        },
        'Exit code did not resolve within timeout — proceeding without it',
      );
      return { code: null, timedOut: true };
    }
    return { code: result, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveGracePeriodMs(override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  const envRaw = process.env.AUTOPOD_POST_COMPLETE_GRACE_MS;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_GRACE_MS;
}

function resolveExitCodeTimeoutMs(override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  const envRaw = process.env.AUTOPOD_EXIT_CODE_TIMEOUT_MS;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_EXIT_CODE_TIMEOUT_MS;
}

/**
 * Pluggable container liveness probe. Tests inject a fake; production uses
 * `defaultContainerProbe` which runs `true` inside the container via
 * ContainerManager.execInContainer.
 */
export type LivenessProbe = () => Promise<boolean>;

/**
 * Default liveness probe: runs `true` inside the container with a hard
 * timeout. Both `execInContainer` hanging on a wedged dockerd AND the command
 * itself failing/timing out count as "not alive".
 */
export function defaultContainerProbe(
  containerManager: ContainerManager,
  containerId: string,
  probeTimeoutMs: number,
): LivenessProbe {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), probeTimeoutMs);
      timer.unref?.();
    });
    try {
      const result = await Promise.race([
        containerManager
          .execInContainer(containerId, ['true'], { timeout: probeTimeoutMs })
          .then((r) => ({ kind: 'ok' as const, exitCode: r.exitCode }))
          .catch(() => ({ kind: 'err' as const })),
        timeoutPromise,
      ]);
      if (result === 'timeout') return false;
      if (result.kind === 'err') return false;
      return result.exitCode === 0;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export interface IdleLivenessProbeOptions {
  /** Streams to force-close when the probe declares the container dead. */
  streams: DestroyableStream[];
  /** Component tag for log lines. */
  runtimeName: string;
  podId: string;
  logger: Logger;
  /**
   * How long without any events before the probe fires. Falls back to
   * `AUTOPOD_IDLE_PROBE_MS` env, then `DEFAULT_IDLE_PROBE_MS`.
   */
  idleTimeoutMs?: number;
  /**
   * Hard ceiling on the probe call itself. Falls back to
   * `AUTOPOD_IDLE_PROBE_TIMEOUT_MS` env, then `DEFAULT_IDLE_PROBE_TIMEOUT_MS`.
   * Only used to compute the default probe — ignored when `probe` is provided.
   */
  probeTimeoutMs?: number;
  /**
   * Liveness probe. Returns true if alive. If omitted, callers must supply
   * `containerManager` + `containerId` for the default probe to be built.
   */
  probe?: LivenessProbe;
  containerManager?: ContainerManager;
  containerId?: string;
}

/**
 * Wrap an agent-event stream with an idle-timeout watchdog. If no event
 * arrives within `idleTimeoutMs`, runs the liveness probe. On probe failure,
 * destroys the underlying streams and yields a fatal error event so the
 * consumer's for-await unwinds cleanly. On probe success, resets the idle
 * timer — the agent is thinking, not wedged.
 *
 * Layer 2 of the wedge-recovery story. Layer 1 (`withPostCompleteGrace`) only
 * arms after a `complete`/fatal-error event. Layer 2 catches stalls that
 * never emit those events at all (mid-tool hangs, dockerd freezes, copilot's
 * stream-end-only `complete`).
 */
export async function* withIdleLivenessProbe(
  source: AsyncIterable<AgentEvent>,
  options: IdleLivenessProbeOptions,
): AsyncIterable<AgentEvent> {
  const idleTimeoutMs = resolveIdleTimeoutMs(options.idleTimeoutMs);
  const probeTimeoutMs = resolveIdleProbeTimeoutMs(options.probeTimeoutMs);
  const probe = options.probe ?? buildDefaultProbe(options, probeTimeoutMs);

  const iterator = source[Symbol.asyncIterator]();
  let pendingNext: Promise<IteratorResult<AgentEvent>> | null = null;

  try {
    while (true) {
      if (!pendingNext) pendingNext = iterator.next();

      let timer: ReturnType<typeof setTimeout> | null = null;
      const idle = new Promise<'idle'>((resolve) => {
        timer = setTimeout(() => resolve('idle'), idleTimeoutMs);
        timer.unref?.();
      });

      type RaceResult = { kind: 'next'; result: IteratorResult<AgentEvent> } | { kind: 'idle' };

      const winner = await Promise.race<RaceResult>([
        pendingNext.then((result) => ({ kind: 'next' as const, result })),
        idle.then(() => ({ kind: 'idle' as const })),
      ]);

      if (timer) clearTimeout(timer);

      if (winner.kind === 'next') {
        pendingNext = null;
        const { value, done } = winner.result;
        if (done) return;
        yield value;
        continue;
      }

      // Idle elapsed — check whether the container is still alive.
      const alive = await probe();
      if (alive) {
        // False alarm: agent is thinking. Loop and wait again. `pendingNext`
        // stays alive across iterations so we don't double-call iterator.next().
        continue;
      }

      options.logger.warn(
        {
          component: options.runtimeName,
          podId: options.podId,
          idleTimeoutMs,
          probeTimeoutMs,
        },
        'Idle liveness probe failed — container appears wedged, force-closing agent streams',
      );

      for (const s of options.streams) {
        if (s.destroyed) continue;
        try {
          if (typeof s.end === 'function') {
            s.end();
          } else if (typeof s.destroy === 'function') {
            s.destroy();
          }
        } catch {
          // best-effort
        }
      }

      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `Container appears wedged — no agent events for ${idleTimeoutMs}ms and liveness probe failed`,
        fatal: true,
      };

      // Bail. Closing the streams should drive the upstream parser to end,
      // but we don't loop again — the synthetic fatal error is the terminal event.
      return;
    }
  } finally {
    // Don't leak an unconsumed iterator.next() on shutdown.
    if (pendingNext) pendingNext.catch(() => {});
    iterator.return?.().catch(() => {});
  }
}

function buildDefaultProbe(
  options: IdleLivenessProbeOptions,
  probeTimeoutMs: number,
): LivenessProbe {
  if (!options.containerManager || !options.containerId) {
    throw new Error(
      'withIdleLivenessProbe: must supply either `probe` or both `containerManager` and `containerId`',
    );
  }
  return defaultContainerProbe(options.containerManager, options.containerId, probeTimeoutMs);
}

function resolveIdleTimeoutMs(override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  const envRaw = process.env.AUTOPOD_IDLE_PROBE_MS;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_IDLE_PROBE_MS;
}

function resolveIdleProbeTimeoutMs(override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  const envRaw = process.env.AUTOPOD_IDLE_PROBE_TIMEOUT_MS;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_IDLE_PROBE_TIMEOUT_MS;
}
