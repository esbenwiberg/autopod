import * as path from 'node:path';
import { CONTAINER_HOME_DIR } from '@autopod/shared';
import type { AgentEvent, Runtime, SpawnConfig } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { CopilotStreamParser } from './copilot-stream-parser.js';

/** Directory inside the container where Copilot stores its config. */
const COPILOT_HOME = `${CONTAINER_HOME_DIR}/.copilot`;

/**
 * GitHub Copilot CLI runtime adapter.
 *
 * Runs `copilot` CLI inside a Docker container via `containerManager.execStreaming()`
 * and parses the plain-text output via CopilotStreamParser.
 *
 * Before spawn, writes:
 * - `$COPILOT_HOME/mcp-config.json` — MCP server configuration
 * - `$COPILOT_HOME/copilot-instructions.md` — custom instructions
 *
 * Auth is via `COPILOT_GITHUB_TOKEN` env var injected from profile credentials.
 *
 * Resume is not supported — Copilot CLI has no session ID targeting mechanism.
 */
export class CopilotRuntime implements Runtime {
  readonly type = 'copilot' as const;

  private handles = new Map<string, StreamingExecResult>();
  private lastModels = new Map<string, string>();
  private logger: Logger;
  private containerManager: ContainerManager;

  constructor(logger: Logger, containerManager: ContainerManager) {
    this.logger = logger;
    this.containerManager = containerManager;
  }

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    // Write config files before spawning
    await this.writeConfigFiles(config);

    const args = this.buildSpawnArgs(config);
    const env = this.buildEnv(config);
    const copilotModel = config.env['COPILOT_MODEL'];
    if (copilotModel) this.lastModels.set(config.sessionId, copilotModel);

    this.logger.info({
      component: 'copilot-runtime',
      sessionId: config.sessionId,
      containerId: config.containerId,
      args,
      msg: 'Spawning copilot in container',
    });

    const handle = await this.containerManager.execStreaming(
      config.containerId,
      ['copilot', ...args],
      { cwd: config.workDir, env },
    );

    this.handles.set(config.sessionId, handle);

    // Emit stderr lines as non-fatal error events; also accumulate for exit error context
    const stderrEvents: AgentEvent[] = [];
    const stderrChunks: string[] = [];
    handle.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (!text) return;
      this.logger.warn(
        { component: 'copilot-runtime', sessionId: config.sessionId, stderr: text.slice(0, 500) },
        'copilot stderr',
      );
      stderrChunks.push(text);
      stderrEvents.push({
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `[stderr] ${text.slice(0, 500)}`,
        fatal: false,
      });
    });

    try {
      for await (const event of CopilotStreamParser.parse(
        handle.stdout,
        config.sessionId,
        this.logger,
      )) {
        for (const e of stderrEvents.splice(0)) yield e;
        yield event;
      }
      for (const e of stderrEvents.splice(0)) yield e;
    } finally {
      this.handles.delete(config.sessionId);
    }

    const exitCode = await handle.exitCode;
    if (exitCode !== 0) {
      const stderrSummary =
        stderrChunks.length > 0 ? `: ${stderrChunks.join('\n').slice(-500)}` : '';
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `Copilot process exited with code ${exitCode}${stderrSummary}`,
        fatal: true,
      };
    }
  }

  async *resume(
    sessionId: string,
    _message: string,
    _containerId: string,
    _env?: Record<string, string>,
  ): AsyncIterable<AgentEvent> {
    this.logger.warn(
      { component: 'copilot-runtime', sessionId },
      'Resume not supported for copilot runtime',
    );
    yield {
      type: 'error',
      timestamp: new Date().toISOString(),
      message: 'Resume not supported for copilot runtime',
      fatal: true,
    };
  }

  async abort(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      this.logger.warn({
        component: 'copilot-runtime',
        sessionId,
        msg: 'No exec handle found to abort',
      });
      return;
    }

    await handle.kill();
    this.handles.delete(sessionId);
    this.lastModels.delete(sessionId);
  }

  async suspend(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      this.logger.warn({
        component: 'copilot-runtime',
        sessionId,
        msg: 'No exec handle found to suspend',
      });
      return;
    }

    this.logger.info({
      component: 'copilot-runtime',
      sessionId,
      msg: 'Suspending copilot session (resume not supported — session state will be lost)',
    });

    await handle.kill();
    this.handles.delete(sessionId);
  }

  private buildSpawnArgs(config: SpawnConfig): string[] {
    const args: string[] = ['-p', config.task];
    const copilotModel = config.env['COPILOT_MODEL'] ?? config.model;
    if (copilotModel) args.push('--model', copilotModel);
    args.push('--allow-all', '--no-ask-user', '-s');
    return args;
  }

  private buildEnv(config: SpawnConfig): Record<string, string> {
    // COPILOT_GITHUB_TOKEN is already set by buildProviderEnv in env-builder.ts.
    // We only need to add COPILOT_HOME to control where config files are written.
    return { ...config.env, COPILOT_HOME };
  }

  private async writeConfigFiles(config: SpawnConfig): Promise<void> {
    // Write MCP config
    if (config.mcpServers && config.mcpServers.length > 0) {
      const mcpConfig: Record<
        string,
        { type: string; url: string; headers?: Record<string, string> }
      > = {};
      for (const server of config.mcpServers) {
        mcpConfig[server.name] = {
          type: 'http',
          url: server.url,
          ...(server.headers && { headers: server.headers }),
        };
      }
      const mcpConfigPath = path.posix.join(COPILOT_HOME, 'mcp-config.json');
      await this.containerManager.writeFile(
        config.containerId,
        mcpConfigPath,
        JSON.stringify({ mcpServers: mcpConfig }, null, 2),
      );
    }

    // Write custom instructions
    if (config.customInstructions) {
      const instructionsPath = path.posix.join(COPILOT_HOME, 'copilot-instructions.md');
      await this.containerManager.writeFile(
        config.containerId,
        instructionsPath,
        config.customInstructions,
      );
    }
  }
}
