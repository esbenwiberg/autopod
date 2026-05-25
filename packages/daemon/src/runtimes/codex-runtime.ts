import { CONTAINER_HOME_DIR } from '@autopod/shared';
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

/** Path inside the container where Codex reads its config (including MCP servers). */
const MCP_CONFIG_PATH = `${CONTAINER_HOME_DIR}/.codex/config.toml`;
const EXTERNAL_SANDBOX_ARGS = ['--dangerously-bypass-approvals-and-sandbox'] as const;

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

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
  private logger: Logger;
  private containerManager: ContainerManager;
  private podRepo: PodRepository;

  constructor(logger: Logger, containerManager: ContainerManager, podRepo: PodRepository) {
    this.logger = logger;
    this.containerManager = containerManager;
    this.podRepo = podRepo;
  }

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    // Write Codex's config.toml so the CLI picks up escalation + profile MCP servers
    // from disk. Codex reads `~/.codex/config.toml` automatically — no flag required.
    await this.writeMcpConfig(config.containerId, config.mcpServers);
    this.mcpServersBySession.set(config.podId, config.mcpServers);

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
      const message =
        exitResult.code === 127
          ? 'Codex CLI not found in container image (exit 127)'
          : `Codex process exited with code ${exitResult.code}`;
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message,
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
    // Re-write the Codex config into the (potentially new) container before launching codex.
    // Crash recovery spawns a fresh container that has no config file on disk; without this
    // re-write the agent loses access to escalation and profile MCP tools after recovery.
    await this.writeMcpConfig(containerId, this.mcpServersBySession.get(podId));

    // Prefer in-memory shortcut; fall back to durable DB source across daemon restarts.
    const sessionId =
      this.codexSessionIds.get(podId) ?? this.podRepo.getOrThrow(podId).codexSessionId;

    const args = sessionId
      ? ['exec', 'resume', sessionId, message, ...EXTERNAL_SANDBOX_ARGS, '--json']
      : ['exec', message, ...EXTERNAL_SANDBOX_ARGS, '--json'];

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
    this.mcpServersBySession.delete(podId);
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
    const args = ['exec', config.task];
    if (config.model !== 'auto') {
      args.push('--model', config.model);
    }
    args.push(...EXTERNAL_SANDBOX_ARGS, '--json');
    return args;
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
      sections.push(lines.join('\n'));
    }

    await this.containerManager.writeFile(
      containerId,
      MCP_CONFIG_PATH,
      `${sections.join('\n\n')}\n`,
    );
  }
}
