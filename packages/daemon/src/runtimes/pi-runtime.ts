import { AUTOPOD_INSTRUCTIONS_PATH, CONTAINER_HOME_DIR } from '@autopod/shared';
import type { AgentEvent, Runtime, SpawnConfig } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { PiRpcParser, type PiRpcStats } from './pi-rpc-parser.js';
import {
  awaitExitCodeBounded,
  withIdleLivenessProbe,
  withPostCompleteGrace,
} from './stream-grace.js';

const PI_WORKER_CONFIG_PATH = `${CONTAINER_HOME_DIR}/.pi/autopod-worker.json`;
const AUTOPOD_PI_MANAGED_STARTUP = {
  packageName: '@autopod/pi-worker',
  extensionId: 'autopod-managed-mcp-worker',
  entrypoint: '@autopod/pi-worker',
  loadProjectExtensions: false,
  allowExecutableProjectResources: false,
} as const;

export class PiRuntime implements Runtime {
  readonly type = 'pi' as const;

  private handles = new Map<string, StreamingExecResult>();
  private sessionIds = new Map<string, string>();
  private spawnConfigs = new Map<string, SpawnConfig>();
  private aborted = new Set<string>();
  private suspended = new Set<string>();
  private commandSeq = 0;

  constructor(
    private readonly logger: Logger,
    private readonly containerManager: ContainerManager,
  ) {}

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    this.aborted.delete(config.podId);
    this.suspended.delete(config.podId);
    this.spawnConfigs.set(config.podId, config);
    await this.writeWorkerConfig(config.containerId, config.mcpServers);

    const args = this.buildArgs(config);
    const safeArgs = args.slice();
    this.logger.info(
      {
        component: 'pi-runtime',
        podId: config.podId,
        containerId: config.containerId,
        args: safeArgs,
      },
      'Spawning Pi managed worker in container',
    );

    yield* this.run(config.podId, config.containerId, config.workDir, args, config.env, {
      method: 'prompt',
      message: config.task,
      model: config.model,
    });
  }

  async *resume(
    podId: string,
    message: string,
    containerId: string,
    env?: Record<string, string>,
  ): AsyncIterable<AgentEvent> {
    const lastConfig = this.spawnConfigs.get(podId);
    if (!lastConfig) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Pi resume failed: no prior spawn config found for pod',
        fatal: true,
      };
      return;
    }

    await this.writeWorkerConfig(containerId, lastConfig.mcpServers);
    const sessionId = this.sessionIds.get(podId);
    const args = this.buildArgs({ ...lastConfig, containerId, env: env ?? lastConfig.env });

    this.logger.info(
      { component: 'pi-runtime', podId, containerId, hasSessionId: Boolean(sessionId) },
      'Resuming Pi managed worker in container',
    );
    yield* this.run(podId, containerId, '/workspace', args, env ?? lastConfig.env, {
      method: sessionId ? 'follow-up' : 'prompt',
      message,
      model: lastConfig.model,
      sessionId,
    });
  }

  async abort(podId: string): Promise<void> {
    const handle = this.handles.get(podId);
    this.aborted.add(podId);
    this.suspended.delete(podId);
    if (handle) await handle.kill();
    this.handles.delete(podId);
    this.sessionIds.delete(podId);
    this.spawnConfigs.delete(podId);
  }

  async suspend(podId: string): Promise<void> {
    const handle = this.handles.get(podId);
    if (!handle) {
      this.logger.warn({ component: 'pi-runtime', podId }, 'No exec handle found to suspend');
      return;
    }
    await handle.kill();
    this.handles.delete(podId);
    this.suspended.add(podId);
  }

  getPiSessionId(podId: string): string | undefined {
    return this.sessionIds.get(podId);
  }

  setPiSessionId(podId: string, sessionId: string): void {
    this.sessionIds.set(podId, sessionId);
  }

  setPiResumeConfig(config: SpawnConfig): void {
    this.spawnConfigs.set(config.podId, config);
  }

  private async *run(
    podId: string,
    containerId: string,
    cwd: string,
    args: string[],
    env: Record<string, string>,
    command: {
      method: 'prompt' | 'follow-up';
      message: string;
      model: string;
      sessionId?: string;
    },
  ): AsyncIterable<AgentEvent> {
    const shimPath = '/run/autopod/agent-shim.sh';
    const handle = await this.containerManager.execStreaming(
      containerId,
      ['sh', shimPath, 'pi', ...args],
      { cwd, env, stdin: true },
    );
    this.handles.set(podId, handle);
    const commandId = this.nextCommandId(podId);
    if (!handle.stdin) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Pi RPC subprocess did not expose stdin',
        fatal: true,
      };
      await handle.kill();
      this.handles.delete(podId);
      return;
    }
    handle.stdin.write(`${JSON.stringify(buildRpcCommand(commandId, command))}\n`);

    const stats: PiRpcStats = { events: 0, nonStatusEvents: 0, sawTerminal: false };
    const expectedResponseIds = new Set<string | number>([commandId]);
    try {
      yield* withPostCompleteGrace(
        withIdleLivenessProbe(
          PiRpcParser.parse(handle.stdout, {
            podId,
            logger: this.logger,
            stats,
            expectedResponseIds,
          }),
          {
            streams: [handle.stdout, handle.stderr],
            runtimeName: 'pi-runtime',
            podId,
            logger: this.logger,
            containerManager: this.containerManager,
            containerId,
          },
        ),
        {
          streams: [handle.stdout, handle.stderr],
          runtimeName: 'pi-runtime',
          podId,
          logger: this.logger,
        },
      );
    } finally {
      this.handles.delete(podId);
    }

    if (this.aborted.has(podId)) {
      this.sessionIds.delete(podId);
      this.spawnConfigs.delete(podId);
      this.aborted.delete(podId);
      this.suspended.delete(podId);
    } else if (stats.sessionId) {
      this.sessionIds.set(podId, stats.sessionId);
    }

    if (this.suspended.has(podId)) {
      this.suspended.delete(podId);
      return;
    }

    if (expectedResponseIds.size > 0) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Pi RPC subprocess exited before acknowledging the command',
        fatal: true,
      };
      return;
    }

    const exit = await awaitExitCodeBounded(handle.exitCode, {
      runtimeName: 'pi-runtime',
      podId,
      logger: this.logger,
    });
    if (exit.timedOut) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Pi exit code did not resolve — container may be unresponsive',
        fatal: false,
      };
    } else if (exit.code !== 0) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `Pi process exited with code ${exit.code}`,
        fatal: true,
      };
    } else if (!stats.sawTerminal || stats.nonStatusEvents === 0) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Pi process exited without terminal agent evidence',
        fatal: true,
      };
    }
  }

  private buildArgs(config: SpawnConfig): string[] {
    const args = [
      'rpc',
      '--managed',
      '--model',
      config.model,
      '--worker-config',
      PI_WORKER_CONFIG_PATH,
      '--worker-package',
      AUTOPOD_PI_MANAGED_STARTUP.packageName,
      '--worker-entrypoint',
      AUTOPOD_PI_MANAGED_STARTUP.entrypoint,
      '--extension-id',
      AUTOPOD_PI_MANAGED_STARTUP.extensionId,
      '--disable-project-extensions',
      '--disable-executable-project-resources',
    ];
    if (config.customInstructions?.trim()) {
      args.push('--system-prompt-file', AUTOPOD_INSTRUCTIONS_PATH);
    }
    args.push('--jsonl');
    return args;
  }

  private nextCommandId(podId: string): string {
    this.commandSeq += 1;
    return `${podId}:${this.commandSeq}`;
  }

  private async writeWorkerConfig(
    containerId: string,
    mcpServers: SpawnConfig['mcpServers'],
  ): Promise<void> {
    const content = JSON.stringify(
      {
        ...AUTOPOD_PI_MANAGED_STARTUP,
        requiredServerName: 'escalation',
        mcpServers: mcpServers ?? [],
      },
      null,
      2,
    );
    await this.containerManager.writeFile(containerId, PI_WORKER_CONFIG_PATH, content);
  }
}
function buildRpcCommand(
  id: string,
  command: {
    method: 'prompt' | 'follow-up';
    message: string;
    model: string;
    sessionId?: string;
  },
): Record<string, unknown> {
  return {
    id,
    method: command.method,
    params: {
      message: command.message,
      model: command.model,
      ...(command.sessionId && { sessionId: command.sessionId }),
    },
  };
}
