import type { AgentEvent, Runtime, SpawnConfig } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import type { PodRepository } from '../pods/pod-repository.js';
import { CodexStreamParser } from './codex-stream-parser.js';
import {
  awaitExitCodeBounded,
  withIdleLivenessProbe,
  withPostCompleteGrace,
} from './stream-grace.js';

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
  private logger: Logger;
  private containerManager: ContainerManager;
  private podRepo: PodRepository;

  constructor(logger: Logger, containerManager: ContainerManager, podRepo: PodRepository) {
    this.logger = logger;
    this.containerManager = containerManager;
    this.podRepo = podRepo;
  }

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    const args = this.buildSpawnArgs(config);
    const safeSpawnArgs = args.map((a, i) => (i === 1 ? `<task: ${a.length} bytes>` : a));

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
      [shimPath, 'codex', ...args],
      { cwd: config.workDir, env: config.env },
    );

    this.handles.set(config.podId, handle);

    const codexSessionIds = this.codexSessionIds;
    const podId = config.podId;
    const logger = this.logger;

    const enriched = (async function* captureSessionId(): AsyncIterable<AgentEvent> {
      for await (const event of CodexStreamParser.parse(handle.stdout, podId, logger)) {
        // Capture session ID from session_configured status events for resume support
        if (event.type === 'status' && event.sessionId) {
          codexSessionIds.set(podId, event.sessionId);
        }
        yield event;
      }
    })();

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

    // Bounded exit-code wait — wedged dockerd would otherwise hang us here
    // even after the stream-grace timer destroyed stdout.
    const exitResult = await awaitExitCodeBounded(handle.exitCode, {
      runtimeName: 'codex-runtime',
      podId: config.podId,
      logger: this.logger,
    });
    if (exitResult.timedOut) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Codex exit code did not resolve — container may be unresponsive',
        fatal: false,
      };
    } else if (exitResult.code !== 0) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `Codex process exited with code ${exitResult.code}`,
        fatal: true,
      };
    }
  }

  async *resume(
    podId: string,
    message: string,
    containerId: string,
    env?: Record<string, string>,
  ): AsyncIterable<AgentEvent> {
    // Prefer in-memory shortcut; fall back to durable DB source across daemon restarts.
    const sessionId =
      this.codexSessionIds.get(podId) ?? this.podRepo.getOrThrow(podId).codexSessionId;

    const args = sessionId
      ? ['exec', 'resume', sessionId, message, '--json']
      : ['exec', message, '--full-auto', '--json'];

    // Redact the message from logs: index 3 with a session ID, index 1 without.
    const messageIndex = sessionId ? 3 : 1;
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
      [shimPath, 'codex', ...args],
      {
        cwd: '/workspace',
        ...(env ? { env } : {}),
      },
    );

    this.handles.set(podId, handle);

    try {
      yield* withPostCompleteGrace(
        withIdleLivenessProbe(CodexStreamParser.parse(handle.stdout, podId, this.logger), {
          streams: [handle.stdout, handle.stderr],
          runtimeName: 'codex-runtime',
          podId,
          logger: this.logger,
          containerManager: this.containerManager,
          containerId,
        }),
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
    return ['exec', config.task, '--model', config.model, '--full-auto', '--json'];
  }
}
