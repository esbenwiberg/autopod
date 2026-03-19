import type { Runtime, SpawnConfig, AgentEvent } from '@autopod/shared';
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
      sessionId: config.sessionId,
      containerId: config.containerId,
      args,
      msg: 'Spawning codex in container',
    });

    const handle = await this.containerManager.execStreaming(
      config.containerId,
      ['codex', ...args],
      { cwd: config.workDir, env: config.env },
    );

    this.handles.set(config.sessionId, handle);

    try {
      yield* CodexStreamParser.parse(handle.stdout, config.sessionId, this.logger);
    } finally {
      this.handles.delete(config.sessionId);
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

  async *resume(sessionId: string, message: string, containerId: string): AsyncIterable<AgentEvent> {
    // Codex CLI doesn't have native session resumption.
    // We pass the message as a follow-up task in full-auto mode.
    const args = [
      'exec',
      message,
      '--full-auto',
      '--json',
    ];

    this.logger.info({
      component: 'codex-runtime',
      sessionId,
      containerId,
      msg: 'Resuming codex with follow-up message in container',
    });

    const handle = await this.containerManager.execStreaming(
      containerId,
      ['codex', ...args],
      { cwd: '/workspace' },
    );

    this.handles.set(sessionId, handle);

    try {
      yield* CodexStreamParser.parse(handle.stdout, sessionId, this.logger);
    } finally {
      this.handles.delete(sessionId);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      this.logger.warn({
        component: 'codex-runtime',
        sessionId,
        msg: 'No exec handle found to abort',
      });
      return;
    }

    await handle.kill();
    this.handles.delete(sessionId);
  }

  async suspend(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      this.logger.warn({
        component: 'codex-runtime',
        sessionId,
        msg: 'No exec handle found to suspend',
      });
      return;
    }

    this.logger.info({
      component: 'codex-runtime',
      sessionId,
      msg: 'Suspending codex session',
    });

    await handle.kill();
    this.handles.delete(sessionId);
  }

  private buildSpawnArgs(config: SpawnConfig): string[] {
    return [
      'exec',
      config.task,
      '--model', config.model,
      '--full-auto',
      '--json',
    ];
  }
}
