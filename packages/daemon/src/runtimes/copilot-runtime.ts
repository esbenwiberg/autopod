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
 * Resume re-spawns copilot with the correction/continuation message as the new task,
 * reusing the stored spawn config (MCP servers, instructions) from the initial spawn.
 * Config files are already in the container so re-writing them is idempotent.
 */
export class CopilotRuntime implements Runtime {
  readonly type = 'copilot' as const;

  private handles = new Map<string, StreamingExecResult>();
  private lastModels = new Map<string, string>();
  private lastSpawnConfigs = new Map<string, SpawnConfig>();
  private logger: Logger;
  private containerManager: ContainerManager;

  constructor(logger: Logger, containerManager: ContainerManager) {
    this.logger = logger;
    this.containerManager = containerManager;
  }

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    // Persist config so resume() can replay a fresh spawn with correction message
    this.lastSpawnConfigs.set(config.sessionId, config);

    // Write config files before spawning
    await this.writeConfigFiles(config);

    const args = this.buildSpawnArgs(config);
    const env = this.buildEnv(config);
    const copilotModel = config.env['COPILOT_MODEL'] ?? null;
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

    // Accumulate stderr into a promise so we catch it even if it arrives after stdout ends
    const stderrPromise = new Promise<string>((resolve) => {
      const chunks: string[] = [];
      handle.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf-8')));
      handle.stderr.on('end', () => resolve(chunks.join('')));
      handle.stderr.on('error', () => resolve(chunks.join('')));
    });

    try {
      for await (const event of CopilotStreamParser.parse(
        handle.stdout,
        config.sessionId,
        this.logger,
      )) {
        yield event;
      }
    } finally {
      this.handles.delete(config.sessionId);
    }

    const [exitCode, stderrText] = await Promise.all([handle.exitCode, stderrPromise]);

    if (stderrText.trim()) {
      this.logger.warn(
        { component: 'copilot-runtime', sessionId: config.sessionId, stderr: stderrText.slice(0, 1000) },
        'copilot stderr',
      );
    }

    if (exitCode !== 0) {
      const stderrSummary = stderrText.trim() ? `: ${stderrText.trim().slice(-500)}` : '';
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
    message: string,
    containerId: string,
    env?: Record<string, string>,
  ): AsyncIterable<AgentEvent> {
    const lastConfig = this.lastSpawnConfigs.get(sessionId);

    if (!lastConfig) {
      this.logger.warn(
        { component: 'copilot-runtime', sessionId },
        'Resume called with no prior spawn config — cannot respawn',
      );
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Copilot resume failed: no prior spawn config found for session',
        fatal: true,
      };
      return;
    }

    this.logger.info(
      { component: 'copilot-runtime', sessionId },
      'Resume: respawning copilot with correction message (no session continuity)',
    );

    // Copilot has no session ID mechanism — respawn with the correction/continuation
    // message as the new task. Reuse stored MCP servers and instructions (already written
    // to container); pass fresh env if provided (token rotation).
    yield* this.spawn({
      ...lastConfig,
      containerId,
      task: message,
      env: env ?? lastConfig.env,
    });
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
    this.lastSpawnConfigs.delete(sessionId);
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
      msg: 'Suspending copilot session (no session continuity — will respawn on resume)',
    });

    await handle.kill();
    this.handles.delete(sessionId);
    // Keep lastSpawnConfigs entry so resume() can respawn after suspension
  }

  private buildSpawnArgs(config: SpawnConfig): string[] {
    const args: string[] = ['-p', config.task];
    const copilotModel = config.env['COPILOT_MODEL'];
    if (copilotModel) args.push('--model', copilotModel);
    args.push('--allow-all', '--no-ask-user', '--no-auto-update', '-s');
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
