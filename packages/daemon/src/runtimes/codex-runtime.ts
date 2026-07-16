import { type Dirent, createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CONTAINER_HOME_DIR, CONTAINER_USER } from '@autopod/shared';
import type { AgentEvent, ExecutionTarget, Runtime, SpawnConfig } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import type { EventBus } from '../pods/event-bus.js';
import type { PodRepository } from '../pods/pod-repository.js';
import { codexStateDirForPod } from './codex-state-store.js';
import { CodexStreamParser } from './codex-stream-parser.js';
import {
  awaitExitCodeBounded,
  withIdleLivenessProbe,
  withPostCompleteGrace,
} from './stream-grace.js';

/** Path inside the container where Codex reads its config (including MCP servers). */
const MCP_CONFIG_PATH = `${CONTAINER_HOME_DIR}/.codex/config.toml`;
const EXTERNAL_SANDBOX_ARGS = ['--dangerously-bypass-approvals-and-sandbox'] as const;
// Codex defaults MCP tool calls to 120s. Autopod tools can legitimately block
// for human approval or long deploy scripts, so give the client a ceiling just
// above the daemon's default 1h human-response timeout.
const CODEX_MCP_TOOL_TIMEOUT_SEC = 3900;
const DEFAULT_ROLLOUT_POLL_MS = 1_000;
const DEFAULT_SUMMARY_GRACE_MS = 30_000;
const DEFAULT_SUMMARY_RECOVERY_TIMEOUT_MS = 30_000;
const DEFAULT_SANDBOX_IDLE_RECOVERY_MS = 60_000;
const DEFAULT_STALLED_EXEC_KILL_TIMEOUT_MS = 5_000;
const CONTAINER_CODEX_SESSIONS_PATH = `${CONTAINER_HOME_DIR}/.codex/sessions`;

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;
const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl$/;

interface ParseStats {
  events: number;
  nonStatusEvents: number;
  sawComplete: boolean;
}

interface OutputState {
  events: number;
  nonStatusEvents: number;
  sawComplete: boolean;
  sawFatal: boolean;
}

interface SandboxRolloutRecovery {
  containerId: string;
}

interface RolloutCandidate {
  path: string;
  mtimeMs: number;
  size: number;
}

interface RolloutTailState {
  path: string | null;
  offset: number;
  carry: Buffer;
}

function escapeTomlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function tomlKey(k: string): string {
  return TOML_BARE_KEY.test(k) ? k : `"${escapeTomlString(k)}"`;
}

function tomlStringVal(s: string): string {
  return `"${escapeTomlString(s)}"`;
}

function tomlArrayVal(values: string[]): string {
  return `[${values.map(tomlStringVal).join(', ')}]`;
}

function tomlInlineTable(obj: Record<string, string>): string {
  const entries = Object.entries(obj).map(([k, v]) => `${tomlKey(k)} = ${tomlStringVal(v)}`);
  return `{ ${entries.join(', ')} }`;
}

/**
 * Codex CLI runtime adapter.
 *
 * Runs `codex` CLI inside a Docker container via `containerManager.execStreaming()`
 * and parses the JSONL output via CodexStreamParser.
 */
export class CodexRuntime implements Runtime {
  readonly type = 'codex' as const;

  private handles = new Map<string, StreamingExecResult>();
  /** Maps autopod podId → Codex session ID for in-memory resume shortcut. */
  readonly codexSessionIds = new Map<string, string>();
  /** Maps autopod podId → MCP servers so resume() can re-write the config into the new container. */
  private mcpServersBySession = new Map<string, SpawnConfig['mcpServers']>();
  /** Maps autopod podId → generated Autopod instructions for no-session resume fallback. */
  private customInstructionsBySession = new Map<string, string>();
  private logger: Logger;
  private containerManager: ContainerManager;
  private podRepo: PodRepository;
  private eventBus?: EventBus;

  constructor(
    logger: Logger,
    containerManager: ContainerManager,
    podRepo: PodRepository,
    eventBus?: EventBus,
  ) {
    this.logger = logger;
    this.containerManager = containerManager;
    this.podRepo = podRepo;
    this.eventBus = eventBus;
  }

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    // A fresh spawn must not inherit the prior turn's durable rollout selector.
    // The new thread.started event will repopulate this map before live rollout
    // polling begins, keeping stale completed sessions from closing the new stream.
    this.codexSessionIds.delete(config.podId);

    // Write Codex's config.toml so the CLI picks up escalation + profile MCP servers
    // from disk. Codex reads `~/.codex/config.toml` automatically — no flag required.
    await this.writeMcpConfig(config.containerId, config.mcpServers, config.executionTarget);
    this.mcpServersBySession.set(config.podId, config.mcpServers);
    if (config.customInstructions?.trim()) {
      this.customInstructionsBySession.set(config.podId, config.customInstructions);
    } else {
      this.customInstructionsBySession.delete(config.podId);
    }

    const args = this.buildSpawnArgs(config);
    const taskIndex = args.length - 1;
    const safeSpawnArgs = args.map((a, i) => (i === taskIndex ? `<task: ${a.length} bytes>` : a));

    this.logger.info({
      component: 'codex-runtime',
      podId: config.podId,
      containerId: config.containerId,
      args: safeSpawnArgs,
      msg: 'Spawning codex in container',
    });

    const shimPath = '/run/autopod/agent-shim.sh';
    const handle = await this.containerManager.execStreaming(
      config.containerId,
      ['sh', shimPath, 'codex', ...args],
      { cwd: config.workDir, env: config.env },
    );

    this.handles.set(config.podId, handle);

    const outputState: OutputState = {
      events: 0,
      nonStatusEvents: 0,
      sawComplete: false,
      sawFatal: false,
    };
    const recovery =
      config.executionTarget === 'sandbox' ? { containerId: config.containerId } : undefined;
    const enriched = this.parseWithRolloutFallback(
      handle,
      config.podId,
      outputState,
      config.model,
      recovery,
    );

    try {
      yield* withPostCompleteGrace(
        withIdleLivenessProbe(enriched, {
          streams: [handle.stdout, handle.stderr],
          runtimeName: 'codex-runtime',
          podId: config.podId,
          logger: this.logger,
          containerManager: this.containerManager,
          containerId: config.containerId,
        }),
        {
          streams: [handle.stdout, handle.stderr],
          runtimeName: 'codex-runtime',
          podId: config.podId,
          logger: this.logger,
        },
      );
    } finally {
      this.handles.delete(config.podId);
    }

    const exitError = await this.codexExitError(config.podId, handle, outputState);
    if (exitError) yield exitError;
  }

  async *resume(
    podId: string,
    message: string,
    containerId: string,
    env?: Record<string, string>,
  ): AsyncIterable<AgentEvent> {
    // Prefer in-memory shortcut; fall back to durable DB source across daemon restarts.
    const pod = this.podRepo.getOrThrow(podId);

    // Re-write the Codex config into the (potentially new) container before launching codex.
    // Crash recovery spawns a fresh container that has no config file on disk; without this
    // re-write the agent loses access to escalation and profile MCP tools after recovery.
    // Pass the pod's execution target so sandbox recovery keeps the config world-readable.
    await this.writeMcpConfig(
      containerId,
      this.mcpServersBySession.get(podId),
      pod.executionTarget,
    );

    const sessionId = this.codexSessionIds.get(podId) ?? pod.codexSessionId;
    if (sessionId) {
      // Seed the active selector before stdout starts. A previous rollout may be
      // newer on disk, but only this resumed session is allowed to contribute events.
      this.codexSessionIds.set(podId, sessionId);
    }

    const prompt = sessionId
      ? message
      : composePrompt(message, this.customInstructionsBySession.get(podId));
    const args = sessionId
      ? ['exec', 'resume', sessionId, ...EXTERNAL_SANDBOX_ARGS, '--json', prompt]
      : ['exec', ...EXTERNAL_SANDBOX_ARGS, '--json', prompt];

    // Redact the message from logs; Codex options must stay before the prompt.
    const messageIndex = args.length - 1;
    const safeResumeArgs = args.map((a, i) =>
      i === messageIndex ? `<task: ${a.length} bytes>` : a,
    );

    this.logger.info({
      component: 'codex-runtime',
      podId,
      containerId,
      sessionId: sessionId ?? null,
      args: safeResumeArgs,
      msg: sessionId
        ? 'Resuming codex session in container'
        : 'Resuming codex with follow-up message in container',
    });

    const shimPath = '/run/autopod/agent-shim.sh';
    const handle = await this.containerManager.execStreaming(
      containerId,
      ['sh', shimPath, 'codex', ...args],
      {
        cwd: '/workspace',
        ...(env ? { env } : {}),
      },
    );

    this.handles.set(podId, handle);

    const outputState: OutputState = {
      events: 0,
      nonStatusEvents: 0,
      sawComplete: false,
      sawFatal: false,
    };
    const recovery = pod.executionTarget === 'sandbox' ? { containerId } : undefined;

    try {
      yield* withPostCompleteGrace(
        withIdleLivenessProbe(
          this.parseWithRolloutFallback(handle, podId, outputState, pod.model, recovery),
          {
            streams: [handle.stdout, handle.stderr],
            runtimeName: 'codex-runtime',
            podId,
            logger: this.logger,
            containerManager: this.containerManager,
            containerId,
          },
        ),
        {
          streams: [handle.stdout, handle.stderr],
          runtimeName: 'codex-runtime',
          podId,
          logger: this.logger,
        },
      );
    } finally {
      this.handles.delete(podId);
    }

    const exitError = await this.codexExitError(podId, handle, outputState);
    if (exitError) yield exitError;
  }

  async abort(podId: string): Promise<void> {
    const handle = this.handles.get(podId);
    if (!handle) {
      this.logger.warn({
        component: 'codex-runtime',
        podId,
        msg: 'No exec handle found to abort',
      });
      return;
    }

    await handle.kill();
    this.handles.delete(podId);
    this.mcpServersBySession.delete(podId);
    this.customInstructionsBySession.delete(podId);
  }

  async suspend(podId: string): Promise<void> {
    const handle = this.handles.get(podId);
    if (!handle) {
      this.logger.warn({
        component: 'codex-runtime',
        podId,
        msg: 'No exec handle found to suspend',
      });
      return;
    }

    this.logger.info({
      component: 'codex-runtime',
      podId,
      msg: 'Suspending codex pod',
    });

    await handle.kill();
    this.handles.delete(podId);
    // NOTE: codexSessionIds is NOT deleted — session survives suspend for resume
  }

  private buildSpawnArgs(config: SpawnConfig): string[] {
    const args = ['exec'];
    if (config.model !== 'auto') {
      args.push('--model', config.model);
    }
    args.push(
      ...EXTERNAL_SANDBOX_ARGS,
      '--json',
      composePrompt(config.task, config.customInstructions),
    );
    return args;
  }

  private async *parseWithRolloutFallback(
    handle: StreamingExecResult,
    podId: string,
    outputState: OutputState,
    modelHint?: string,
    summaryRecovery?: SandboxRolloutRecovery,
  ): AsyncIterable<AgentEvent> {
    const seen = new Set<string>();
    const abortLiveRollout = new AbortController();
    const abortSummaryGrace = new AbortController();
    const rolloutTail: RolloutTailState = { path: null, offset: 0, carry: Buffer.alloc(0) };
    let taskSummaryObserved = false;
    let resolveTaskSummary: (() => void) | null = null;
    const taskSummarySignal = new Promise<void>((resolve) => {
      resolveTaskSummary = resolve;
    });
    const unsubscribeTaskSummary =
      summaryRecovery && this.eventBus
        ? this.eventBus.subscribeToSession(podId, (event) => {
            if (
              taskSummaryObserved ||
              event.type !== 'pod.agent_activity' ||
              event.event.type !== 'task_summary'
            ) {
              return;
            }
            taskSummaryObserved = true;
            resolveTaskSummary?.();
          })
        : null;
    const stdoutIterator = this.parseCodexLines(handle.stdout, podId, seen, outputState, modelHint)[
      Symbol.asyncIterator
    ]();
    const rolloutIterator = this.pollLatestRollout(
      podId,
      abortLiveRollout.signal,
      modelHint,
      rolloutTail,
    )[Symbol.asyncIterator]();

    let stdoutStats: ParseStats = { events: 0, nonStatusEvents: 0, sawComplete: false };
    let stdoutDone = false;
    let stdoutNext = nextFrom('stdout', stdoutIterator);
    let rolloutNext = nextFrom('rollout', rolloutIterator);
    let taskSummaryNext = unsubscribeTaskSummary
      ? taskSummarySignal.then(() => ({ source: 'task-summary' as const }))
      : neverRuntimeSignal<'task-summary'>();
    let summaryRecoveryNext = neverRuntimeSignal<'summary-recovery'>();
    let lastMergedEventAt = Date.now();
    let sandboxIdleRecoveryNext = summaryRecovery
      ? sleep(sandboxIdleRecoveryPeriodMs(), abortLiveRollout.signal).then(() => ({
          source: 'sandbox-idle-recovery' as const,
        }))
      : neverRuntimeSignal<'sandbox-idle-recovery'>();

    try {
      while (!stdoutDone) {
        const next = await Promise.race([
          stdoutNext,
          rolloutNext,
          taskSummaryNext,
          summaryRecoveryNext,
          sandboxIdleRecoveryNext,
        ]);
        if (next.source === 'task-summary') {
          taskSummaryNext = neverRuntimeSignal<'task-summary'>();
          if (!outputState.sawComplete) {
            lastMergedEventAt = Date.now();
            const graceMs = summaryGracePeriodMs();
            this.logger.info(
              { component: 'codex-runtime', podId, graceMs },
              'Codex reported its final task summary — awaiting terminal stream proof',
            );
            summaryRecoveryNext = sleep(graceMs, abortSummaryGrace.signal).then(() => ({
              source: 'summary-recovery' as const,
            }));
          }
          continue;
        }
        if (next.source === 'summary-recovery') {
          if (outputState.sawComplete) {
            summaryRecoveryNext = neverRuntimeSignal<'summary-recovery'>();
            continue;
          }
          if (summaryRecovery) {
            yield* this.recoverSandboxAfterTaskSummary(
              summaryRecovery,
              podId,
              seen,
              outputState,
              modelHint,
              rolloutTail,
            );
          }
          return;
        }
        if (next.source === 'sandbox-idle-recovery') {
          const recoveryPeriodMs = sandboxIdleRecoveryPeriodMs();
          const remainingMs = recoveryPeriodMs - (Date.now() - lastMergedEventAt);
          if (remainingMs > 0) {
            sandboxIdleRecoveryNext = sleep(remainingMs, abortLiveRollout.signal).then(() => ({
              source: 'sandbox-idle-recovery' as const,
            }));
            continue;
          }

          if (summaryRecovery) {
            yield* this.recoverSandboxLiveProgress(
              summaryRecovery,
              podId,
              seen,
              outputState,
              modelHint,
              rolloutTail,
            );
          }
          lastMergedEventAt = Date.now();
          if (outputState.sawComplete) return;
          sandboxIdleRecoveryNext = sleep(recoveryPeriodMs, abortLiveRollout.signal).then(() => ({
            source: 'sandbox-idle-recovery' as const,
          }));
          continue;
        }
        if (next.source === 'stdout') {
          if (next.result.done) {
            const readyRollout = await settledOrNull(rolloutNext);
            if (readyRollout && !readyRollout.result.done) {
              const event = readyRollout.result.value;
              const key = dedupeKey(event);
              if (!shouldSkipMergedEvent(event, key, seen, outputState)) {
                seen.add(key);
                yield event;
                recordOutputEvent(outputState, event);
                lastMergedEventAt = Date.now();
              }
              rolloutNext = nextFrom('rollout', rolloutIterator);
              continue;
            }
            stdoutDone = true;
            stdoutStats = next.result.value;
            if (taskSummaryObserved && !outputState.sawComplete && summaryRecovery) {
              yield* this.recoverSandboxAfterTaskSummary(
                summaryRecovery,
                podId,
                seen,
                outputState,
                modelHint,
                rolloutTail,
              );
              return;
            }
          } else {
            yield next.result.value;
            lastMergedEventAt = Date.now();
            stdoutNext = nextFrom('stdout', stdoutIterator);
          }
        } else if (next.result.done) {
          rolloutNext = neverSettles<'rollout'>();
        } else {
          const event = next.result.value;
          const key = dedupeKey(event);
          if (shouldSkipMergedEvent(event, key, seen, outputState)) {
            rolloutNext = nextFrom('rollout', rolloutIterator);
            continue;
          }
          seen.add(key);
          yield event;
          recordOutputEvent(outputState, event);
          lastMergedEventAt = Date.now();
          rolloutNext = nextFrom('rollout', rolloutIterator);
        }
      }
    } finally {
      abortLiveRollout.abort();
      abortSummaryGrace.abort();
      unsubscribeTaskSummary?.();
      await rolloutIterator.return?.();
    }

    if (stdoutStats.sawComplete && stdoutStats.nonStatusEvents > 0) return;

    yield* this.replayLatestRollout(podId, seen, stdoutStats, outputState, modelHint, rolloutTail);
  }

  private async *recoverSandboxAfterTaskSummary(
    recovery: SandboxRolloutRecovery,
    podId: string,
    seen: Set<string>,
    outputState: OutputState,
    modelHint?: string,
    rolloutTail: RolloutTailState = { path: null, offset: 0, carry: Buffer.alloc(0) },
  ): AsyncIterable<AgentEvent> {
    const hostSessionsPath = codexStateDirForPod(podId);
    const timeoutMs = summaryRecoveryTimeoutMs();

    this.logger.warn(
      { component: 'codex-runtime', podId, containerId: recovery.containerId, timeoutMs },
      'Codex terminal stream stalled after final task summary — extracting sandbox session state',
    );

    const extraction = await settlePromiseWithin(
      this.containerManager.extractDirectoryFromContainer(
        recovery.containerId,
        CONTAINER_CODEX_SESSIONS_PATH,
        hostSessionsPath,
      ),
      timeoutMs,
    );
    if (extraction.status === 'timed-out') {
      yield summaryRecoveryError(
        outputState,
        'Codex reported its final task summary, but sandbox session extraction timed out before terminal completion',
      );
      return;
    }
    if (extraction.status === 'rejected') {
      yield summaryRecoveryError(
        outputState,
        `Codex reported its final task summary, but sandbox session extraction failed before terminal completion: ${errorMessage(extraction.reason)}`,
      );
      return;
    }

    const sessionId = this.codexSessionIds.get(podId);
    if (!sessionId) {
      yield summaryRecoveryError(
        outputState,
        'Codex reported its final task summary, but no active session ID was available for safe rollout recovery',
      );
      return;
    }

    try {
      const rollout = await findLatestCodexRollout(hostSessionsPath, sessionId);
      if (!rollout) {
        yield summaryRecoveryError(
          outputState,
          'Codex reported its final task summary, but the extracted sandbox state had no rollout for the active session',
        );
        return;
      }

      this.logger.warn(
        { component: 'codex-runtime', podId, sessionId, rolloutPath: rollout.path },
        'Replaying the active Codex sandbox rollout to recover terminal completion',
      );
      const complete = await readRolloutDelta(rollout, rolloutTail);
      if (complete.length > 0) {
        yield* this.parseCodexLines(Readable.from([complete]), podId, seen, outputState, modelHint);
      }
    } catch (err) {
      yield summaryRecoveryError(
        outputState,
        `Codex reported its final task summary, but the active sandbox rollout could not be replayed: ${errorMessage(err)}`,
      );
      return;
    }

    if (!outputState.sawComplete) {
      yield summaryRecoveryError(
        outputState,
        'Codex reported its final task summary, but the active sandbox rollout contained no terminal completion proof',
      );
    }
  }

  private async *recoverSandboxLiveProgress(
    recovery: SandboxRolloutRecovery,
    podId: string,
    seen: Set<string>,
    outputState: OutputState,
    modelHint?: string,
    rolloutTail: RolloutTailState = { path: null, offset: 0, carry: Buffer.alloc(0) },
  ): AsyncIterable<AgentEvent> {
    const hostSessionsPath = codexStateDirForPod(podId);
    const timeoutMs = summaryRecoveryTimeoutMs();
    const extraction = await settlePromiseWithin(
      this.containerManager.extractDirectoryFromContainer(
        recovery.containerId,
        CONTAINER_CODEX_SESSIONS_PATH,
        hostSessionsPath,
      ),
      timeoutMs,
    );
    if (extraction.status !== 'fulfilled') {
      this.logger.warn(
        {
          component: 'codex-runtime',
          podId,
          containerId: recovery.containerId,
          status: extraction.status,
        },
        'Could not snapshot idle Codex sandbox rollout — will retry while the stream stays silent',
      );
      return;
    }

    const sessionId = this.codexSessionIds.get(podId);
    if (!sessionId) return;
    try {
      const rollout = await findLatestCodexRollout(hostSessionsPath, sessionId);
      if (!rollout) return;

      this.logger.warn(
        { component: 'codex-runtime', podId, sessionId, rolloutPath: rollout.path },
        'Codex sandbox stream is idle — replaying active rollout progress',
      );
      const complete = await readRolloutDelta(rollout, rolloutTail);
      if (complete.length > 0) {
        yield* this.parseCodexLines(Readable.from([complete]), podId, seen, outputState, modelHint);
      }
    } catch (err) {
      this.logger.warn(
        { err, component: 'codex-runtime', podId, sessionId },
        'Could not replay idle Codex sandbox rollout — will retry if the stream stays silent',
      );
    }
  }

  private async codexExitError(
    podId: string,
    handle: StreamingExecResult,
    outputState: OutputState,
  ): Promise<AgentEvent | null> {
    if (outputState.sawFatal) return null;

    // Bounded exit-code wait — wedged dockerd would otherwise hang us here
    // even after the stream-grace timer destroyed stdout.
    const exitResult = await awaitExitCodeBounded(handle.exitCode, {
      runtimeName: 'codex-runtime',
      podId,
      logger: this.logger,
    });

    if (exitResult.timedOut) {
      const killResult = await settlePromiseWithin(handle.kill(), stalledExecKillTimeoutMs());
      if (killResult.status !== 'fulfilled') {
        this.logger.warn(
          {
            component: 'codex-runtime',
            podId,
            status: killResult.status,
            ...(killResult.status === 'rejected' ? { err: killResult.reason } : {}),
          },
          'Failed to terminate stalled Codex exec after unresolved exit code',
        );
      }
      // Work is done when sawComplete is true — we have terminal completion
      // proof (from the stream or recovered rollout). A stalled exit code at
      // that point is not a reason to discard completed work: we kill the exec
      // as best-effort insurance and proceed to validation. Only an unresolved
      // exit code *without* completion proof is fatal (genuinely incomplete).
      return {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: outputState.sawComplete
          ? 'Codex exit code did not resolve after task completion — terminated stalled exec, proceeding to validation'
          : 'Codex exit code did not resolve before task completion — refusing to mark pod complete',
        fatal: !outputState.sawComplete,
      };
    }

    if (exitResult.code !== 0) {
      const message =
        exitResult.code === 127
          ? 'Codex CLI not found in container image (exit 127)'
          : `Codex process exited with code ${exitResult.code}`;
      return {
        type: 'error',
        timestamp: new Date().toISOString(),
        message,
        fatal: true,
      };
    }

    if (!outputState.sawComplete) {
      return {
        type: 'error',
        timestamp: new Date().toISOString(),
        message:
          'Codex exited without terminal completion (turn.completed/task_complete) — refusing to mark pod complete',
        fatal: true,
      };
    }

    if (outputState.nonStatusEvents === 0) {
      return {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Codex exited successfully without JSON activity on stdout or rollout JSONL',
        fatal: true,
      };
    }

    return null;
  }

  private async *parseCodexLines(
    lines: Readable,
    podId: string,
    seen: Set<string>,
    outputState: OutputState,
    modelHint?: string,
  ): AsyncGenerator<AgentEvent, ParseStats, void> {
    const iterator = this.parseCodexLinesRaw(lines, podId, modelHint)[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done) return next.value;

      const event = next.value;
      const key = dedupeKey(event);
      if (shouldSkipMergedEvent(event, key, seen, outputState)) continue;
      seen.add(key);
      yield event;
      recordOutputEvent(outputState, event);
    }
  }

  private async *parseCodexLinesRaw(
    lines: Readable,
    podId: string,
    modelHint?: string,
  ): AsyncGenerator<AgentEvent, ParseStats, void> {
    const stats: ParseStats = { events: 0, nonStatusEvents: 0, sawComplete: false };

    for await (const event of CodexStreamParser.parse(lines, podId, this.logger, modelHint)) {
      stats.events += 1;
      if (event.type !== 'status') stats.nonStatusEvents += 1;
      if (event.type === 'complete') stats.sawComplete = true;
      if (event.type === 'status' && event.sessionId) {
        this.codexSessionIds.set(podId, event.sessionId);
      }

      yield event;
    }

    return stats;
  }

  private async *replayLatestRollout(
    podId: string,
    seen: Set<string>,
    stdoutStats: ParseStats,
    outputState: OutputState,
    modelHint?: string,
    rolloutTail: RolloutTailState = { path: null, offset: 0, carry: Buffer.alloc(0) },
  ): AsyncGenerator<AgentEvent, ParseStats, void> {
    const activeSessionId = this.codexSessionIds.get(podId);
    const rollout = await findLatestCodexRollout(codexStateDirForPod(podId), activeSessionId);
    if (!rollout) {
      this.logger.warn(
        {
          component: 'codex-runtime',
          podId,
          stdoutEvents: stdoutStats.events,
          stdoutNonStatusEvents: stdoutStats.nonStatusEvents,
          stdoutSawComplete: stdoutStats.sawComplete,
        },
        'Codex stdout stream ended without complete activity and no rollout JSONL was found',
      );
      return { events: 0, nonStatusEvents: 0, sawComplete: false };
    }

    this.logger.warn(
      {
        component: 'codex-runtime',
        podId,
        rolloutPath: rollout.path,
        stdoutEvents: stdoutStats.events,
        stdoutNonStatusEvents: stdoutStats.nonStatusEvents,
        stdoutSawComplete: stdoutStats.sawComplete,
      },
      'Codex stdout stream ended without complete activity — replaying rollout JSONL',
    );

    const complete = await readRolloutDelta(rollout, rolloutTail);
    if (complete.length === 0) {
      return { events: 0, nonStatusEvents: 0, sawComplete: false };
    }
    return yield* this.parseCodexLines(
      Readable.from([complete]),
      podId,
      seen,
      outputState,
      modelHint,
    );
  }

  private async *pollLatestRollout(
    podId: string,
    signal: AbortSignal,
    modelHint?: string,
    tail: RolloutTailState = { path: null, offset: 0, carry: Buffer.alloc(0) },
  ): AsyncGenerator<AgentEvent, void, void> {
    while (!signal.aborted) {
      try {
        // Do not replay anything until stdout identifies the active thread (spawn)
        // or resume pre-seeds it. Otherwise an older completed rollout can arm the
        // post-complete grace timer and terminate the live Codex exec.
        const activeSessionId = this.codexSessionIds.get(podId);
        const rollout = activeSessionId
          ? await findLatestCodexRollout(codexStateDirForPod(podId), activeSessionId)
          : null;
        if (rollout) {
          const complete = await readRolloutDelta(rollout, tail);
          if (complete.length > 0) {
            yield* this.parseCodexLinesRaw(Readable.from([complete]), podId, modelHint);
          }
        }
      } catch (err) {
        this.logger.warn(
          { component: 'codex-runtime', podId, err },
          'Failed to poll Codex rollout JSONL',
        );
      }

      await sleep(rolloutPollIntervalMs(), signal);
    }
  }

  /**
   * Write Codex's config.toml inside the container with the requested MCP servers.
   *
   * Codex reads `~/.codex/config.toml` automatically on every invocation, so no CLI
   * flag is needed. The bind-mount in pod-manager.ts attaches `~/.codex/sessions`
   * only, leaving `config.toml` in the container's writable layer (which is what we
   * want — recovery into a fresh container needs the file re-written).
   *
   * HTTP entries emit `url` + optional `http_headers`; stdio entries emit
   * `command` + optional `args` / `env`. Server names are quoted defensively
   * since the table key has to round-trip whatever the profile chose.
   */
  private async writeMcpConfig(
    containerId: string,
    mcpServers: SpawnConfig['mcpServers'],
    executionTarget?: ExecutionTarget,
  ): Promise<void> {
    if (!mcpServers || mcpServers.length === 0) return;

    const sections: string[] = [];
    for (const server of mcpServers) {
      const lines: string[] = [`[mcp_servers.${tomlKey(server.name)}]`];
      if (server.type === 'stdio') {
        lines.push(`command = ${tomlStringVal(server.command)}`);
        if (server.args && server.args.length > 0) {
          lines.push(`args = ${tomlArrayVal(server.args)}`);
        }
        if (server.env && Object.keys(server.env).length > 0) {
          lines.push(`env = ${tomlInlineTable(server.env)}`);
        }
      } else {
        lines.push(`url = ${tomlStringVal(server.url)}`);
        if (server.headers && Object.keys(server.headers).length > 0) {
          lines.push(`http_headers = ${tomlInlineTable(server.headers)}`);
        }
      }
      lines.push(`tool_timeout_sec = ${CODEX_MCP_TOOL_TIMEOUT_SEC.toFixed(1)}`);
      sections.push(lines.join('\n'));
    }

    await this.containerManager.writeFile(
      containerId,
      MCP_CONFIG_PATH,
      `${sections.join('\n\n')}\n`,
    );
    // On sandbox the files API writes root-owned files and exec runs as a
    // non-root, non-`autopod` user (the same reason secret files use 0444 and
    // build binaries are repaired to a+rx). A 0600 `autopod`-only config would
    // then be unreadable by the reviewer's `codex exec`. Both the native stream
    // and buffered fallback run as the sandbox-assigned non-root user, so the
    // pre-submit review dies with "config.toml: Permission denied". Use
    // world-readable 0644 there; the sandbox is single-tenant and
    // OPENAI_API_KEY is already 0444.
    // Docker keeps 0600 (single `autopod` user; exec runs as `autopod`).
    const configMode = executionTarget === 'sandbox' ? '0644' : '0600';
    const secureConfig = await this.containerManager.execInContainer(
      containerId,
      [
        'sh',
        '-c',
        `chown ${CONTAINER_USER}:${CONTAINER_USER} '${MCP_CONFIG_PATH}' && chmod ${configMode} '${MCP_CONFIG_PATH}'`,
      ],
      { timeout: 5_000, user: 'root' },
    );
    if (secureConfig.exitCode !== 0) {
      throw new Error(
        `Failed to secure Codex MCP config (exit ${secureConfig.exitCode}): ${secureConfig.stderr}`,
      );
    }
  }
}

function composePrompt(task: string, customInstructions?: string): string {
  const instructions = customInstructions?.trim();
  if (!instructions) return task;
  return [
    instructions,
    '',
    '---',
    '',
    '## Current Codex Turn',
    '',
    'Follow the Autopod workflow requirements above while handling this current request:',
    '',
    task,
  ].join('\n');
}

function dedupeKey(event: AgentEvent): string {
  return JSON.stringify(event);
}

function shouldSkipMergedEvent(
  event: AgentEvent,
  key: string,
  seen: Set<string>,
  outputState: OutputState,
): boolean {
  return seen.has(key) || (event.type === 'complete' && outputState.sawComplete);
}

function recordOutputEvent(state: OutputState, event: AgentEvent): void {
  state.events += 1;
  if (event.type !== 'status') state.nonStatusEvents += 1;
  if (event.type === 'complete') state.sawComplete = true;
  if (event.type === 'error' && event.fatal) state.sawFatal = true;
}

function summaryRecoveryError(state: OutputState, message: string): AgentEvent {
  const event: AgentEvent = {
    type: 'error',
    timestamp: new Date().toISOString(),
    message,
    fatal: true,
  };
  recordOutputEvent(state, event);
  return event;
}

function nextFrom<Source extends 'stdout' | 'rollout'>(
  source: Source,
  iterator: AsyncIterator<AgentEvent, Source extends 'stdout' ? ParseStats : void>,
): Promise<{
  source: Source;
  result: IteratorResult<AgentEvent, Source extends 'stdout' ? ParseStats : void>;
}> {
  return iterator.next().then((result) => ({ source, result }));
}

function neverSettles<Source extends 'stdout' | 'rollout'>(): Promise<{
  source: Source;
  result: IteratorResult<AgentEvent, Source extends 'stdout' ? ParseStats : void>;
}> {
  return new Promise(() => {});
}

function neverRuntimeSignal<
  Source extends 'task-summary' | 'summary-recovery' | 'sandbox-idle-recovery',
>(): Promise<{
  source: Source;
}> {
  return new Promise(() => {});
}

function settledOrNull<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([promise, Promise.resolve(null)]);
}

function rolloutPollIntervalMs(): number {
  const configured = Number.parseInt(
    process.env.AUTOPOD_CODEX_ROLLOUT_POLL_MS ?? `${DEFAULT_ROLLOUT_POLL_MS}`,
    10,
  );
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ROLLOUT_POLL_MS;
}

function summaryGracePeriodMs(): number {
  return positiveEnvMs('AUTOPOD_CODEX_SUMMARY_GRACE_MS', DEFAULT_SUMMARY_GRACE_MS);
}

function summaryRecoveryTimeoutMs(): number {
  return positiveEnvMs(
    'AUTOPOD_CODEX_SUMMARY_RECOVERY_TIMEOUT_MS',
    DEFAULT_SUMMARY_RECOVERY_TIMEOUT_MS,
  );
}

function sandboxIdleRecoveryPeriodMs(): number {
  return positiveEnvMs('AUTOPOD_CODEX_SANDBOX_IDLE_RECOVERY_MS', DEFAULT_SANDBOX_IDLE_RECOVERY_MS);
}

function stalledExecKillTimeoutMs(): number {
  return positiveEnvMs(
    'AUTOPOD_CODEX_STALLED_EXEC_KILL_TIMEOUT_MS',
    DEFAULT_STALLED_EXEC_KILL_TIMEOUT_MS,
  );
}

function positiveEnvMs(name: string, fallback: number): number {
  const configured = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

type PromiseSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'timed-out' };

async function settlePromiseWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<PromiseSettlement<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ status: 'timed-out' }>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timed-out' }), timeoutMs);
    timer.unref?.();
  });
  const settlement = promise.then<PromiseSettlement<T>>(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );

  try {
    return await Promise.race([settlement, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readRolloutDelta(
  rollout: RolloutCandidate,
  tail: RolloutTailState,
): Promise<string> {
  if (tail.path !== rollout.path || rollout.size < tail.offset) {
    tail.path = rollout.path;
    tail.offset = 0;
    tail.carry = Buffer.alloc(0);
  }
  if (rollout.size <= tail.offset) return '';

  const appended = await readRolloutAppend(rollout.path, tail.offset, rollout.size);
  const parsed = splitCompleteJsonLines(Buffer.concat([tail.carry, appended]));
  tail.offset = rollout.size;
  tail.carry = parsed.carry;
  return parsed.complete;
}

async function readRolloutAppend(pathname: string, start: number, size: number): Promise<Buffer> {
  if (size <= start) return Buffer.alloc(0);
  const stream = createReadStream(pathname, { start, end: size - 1 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function splitCompleteJsonLines(content: Buffer): { complete: string; carry: Buffer } {
  const lines: string[] = [];
  let lineStart = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== 0x0a) continue;
    const line = content.subarray(lineStart, index).toString('utf8');
    if (line.trim().length > 0) lines.push(line);
    lineStart = index + 1;
  }
  let carry = content.subarray(lineStart);

  // Codex rollout snapshots do not always end with a newline. A syntactically
  // complete trailing JSON value is safe to consume; an incomplete write must
  // stay buffered as bytes until a later poll supplies the rest of the record.
  // Keeping bytes also prevents a poll split inside a multibyte UTF-8 scalar
  // from being decoded to a replacement character and lost permanently.
  const trailing = carry.toString('utf8');
  if (trailing.trim().length > 0 && isCompleteJsonRecord(trailing)) {
    lines.push(trailing);
    carry = Buffer.alloc(0);
  }

  return {
    complete: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    carry,
  };
}

function isCompleteJsonRecord(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

async function findLatestCodexRollout(
  rootDir: string,
  sessionId?: string,
): Promise<RolloutCandidate | null> {
  const candidates: RolloutCandidate[] = [];
  await collectRolloutFiles(rootDir, candidates);
  const eligible = sessionId
    ? candidates.filter((candidate) => path.basename(candidate.path).includes(sessionId))
    : candidates;
  eligible.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return eligible[0] ?? null;
}

async function collectRolloutFiles(dir: string, candidates: RolloutCandidate[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRolloutFiles(entryPath, candidates);
      continue;
    }
    if (!entry.isFile() || !ROLLOUT_FILE_RE.test(entry.name)) continue;
    const info = await stat(entryPath);
    candidates.push({ path: entryPath, mtimeMs: info.mtimeMs, size: info.size });
  }
}
