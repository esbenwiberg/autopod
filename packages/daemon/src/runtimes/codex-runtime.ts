import type { AgentEvent, Runtime, SpawnConfig } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { CodexStreamParser } from './codex-stream-parser.js';

/**
 * Codex CLI runtime adapter.
 *
 * Runs `codex` CLI inside a Docker container via `containerManager.execStreaming()`
 * and parses the JSONL output via CodexStreamParser.
 */
export class CodexRuntime implements Runtime {
  readonly type = 'codex' as const;

  private handles = new Map<string, StreamingExecResult>();
  private logger: Logger;
  private containerManager: ContainerManager;

  constructor(logger: Logger, containerManager: ContainerManager) {
    this.logger = logger;
    this.containerManager = containerManager;
  }

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    const args = this.buildSpawnArgs(config);

    this.logger.info({
      component: 'codex-runtime',
      podId: config.podId,
      containerId: config.containerId,
      args,
      msg: 'Spawning codex in container',
    });

    const shimPath = '/run/autopod/agent-shim.sh';
    const handle = await this.containerManager.execStreaming(
      config.containerId,
      [shimPath, 'codex', ...args],
      { cwd: config.workDir, env: config.env },
    );

    this.handles.set(config.podId, handle);

    try {
      yield* CodexStreamParser.parse(handle.stdout, config.podId, this.logger);
    } finally {
      this.handles.delete(config.podId);
    }

    // Check exit code after stream is consumed
    const exitCode = await handle.exitCode;
    if (exitCode !== 0) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `Codex process exited with code ${exitCode}`,
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
    // Codex CLI doesn't have native pod resumption.
    // We pass the message as a follow-up task in full-auto mode.
    const args = ['exec', message, '--full-auto', '--json'];

    this.logger.info({
      component: 'codex-runtime',
      podId,
      containerId,
      msg: 'Resuming codex with follow-up message in container',
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
      yield* CodexStreamParser.parse(handle.stdout, podId, this.logger);
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
  }

  private buildSpawnArgs(config: SpawnConfig): string[] {
    return ['exec', config.task, '--model', config.model, '--full-auto', '--json'];
  }
}
