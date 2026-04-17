import { randomUUID } from 'node:crypto';
import { AUTOPOD_INSTRUCTIONS_PATH } from '@autopod/shared';
import type { AgentEvent, Runtime, SpawnConfig } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { ClaudeStreamParser } from './claude-stream-parser.js';

/** Path inside the container where the MCP config JSON is written. */
const MCP_CONFIG_PATH = '/home/autopod/.autopod/mcp-config.json';

/**
 * Claude CLI runtime adapter.
 *
 * Runs `claude` CLI inside a Docker container via `containerManager.execStreaming()`
 * and parses the NDJSON output via ClaudeStreamParser.
 */
export class ClaudeRuntime implements Runtime {
  readonly type = 'claude' as const;

  private handles = new Map<string, StreamingExecResult>();
  /** Maps autopod podId → Claude CLI pod_id for resume support. */
  private claudeSessionIds = new Map<string, string>();
  /** Maps autopod podId → MCP servers so resume() can re-write the config into the new container. */
  private mcpServersBySession = new Map<string, SpawnConfig['mcpServers']>();
  private logger: Logger;
  private containerManager: ContainerManager;

  constructor(logger: Logger, containerManager: ContainerManager) {
    this.logger = logger;
    this.containerManager = containerManager;
  }

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    // Write MCP config to a file inside the container so Claude CLI can read it
    // via --mcp-config <path>. Passing inline JSON breaks due to shell escaping
    // inside containerManager.execStreaming().
    await this.writeMcpConfig(config.containerId, config.mcpServers);
    this.mcpServersBySession.set(config.podId, config.mcpServers);

    const args = this.buildSpawnArgs(config);

    this.logger.info({
      component: 'claude-runtime',
      podId: config.podId,
      containerId: config.containerId,
      args,
      msg: 'Spawning claude in container',
    });

    const handle = await this.containerManager.execStreaming(
      config.containerId,
      ['claude', ...args],
      { cwd: config.workDir, env: config.env },
    );

    this.handles.set(config.podId, handle);

    // Emit stderr lines in real-time as error events so they appear in the TUI immediately
    const stderrEvents: AgentEvent[] = [];
    handle.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (!text) return;
      this.logger.warn(
        { component: 'claude-runtime', podId: config.podId, stderr: text.slice(0, 500) },
        'claude stderr',
      );
      stderrEvents.push({
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `[stderr] ${text.slice(0, 500)}`,
        fatal: false,
      });
    });

    try {
      for await (const event of ClaudeStreamParser.parse(
        handle.stdout,
        config.podId,
        this.logger,
      )) {
        // Flush any stderr events that arrived before the next stdout event
        for (const e of stderrEvents.splice(0)) yield e;

        // Capture Claude's pod ID from init events for resume support
        if (event.type === 'status' && event.message.includes('Claude pod initialized')) {
          const match = event.message.match(/\(([^)]+)\)$/);
          if (match?.[1]) {
            this.claudeSessionIds.set(config.podId, match[1]);
          }
        }
        yield event;
      }
      // Flush any remaining stderr events after stdout closes
      for (const e of stderrEvents.splice(0)) yield e;
    } finally {
      this.handles.delete(config.podId);
    }

    // Check exit code after stream is consumed
    const exitCode = await handle.exitCode;
    if (exitCode !== 0) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `Claude process exited with code ${exitCode}`,
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
    const claudeSessionId = this.claudeSessionIds.get(podId);
    // Re-write the MCP config into the (potentially new) container before launching Claude.
    // Without this, recovery spawns a fresh container that never has the config file, causing
    // Claude to error immediately and exit — which then breaks smoke-test execs with 409.
    const mcpServers = this.mcpServersBySession.get(podId);
    await this.writeMcpConfig(containerId, mcpServers);
    const args = this.buildResumeArgs(message, claudeSessionId, mcpServers);

    this.logger.info({
      component: 'claude-runtime',
      podId,
      containerId,
      claudeSessionId,
      msg: 'Resuming claude pod in container',
    });

    const handle = await this.containerManager.execStreaming(containerId, ['claude', ...args], {
      cwd: '/workspace',
      ...(env ? { env } : {}),
    });

    this.handles.set(podId, handle);

    const stderrEvents: AgentEvent[] = [];
    handle.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (!text) return;
      this.logger.warn(
        { component: 'claude-runtime', podId, stderr: text.slice(0, 500) },
        'claude stderr',
      );
      stderrEvents.push({
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `[stderr] ${text.slice(0, 500)}`,
        fatal: false,
      });
    });

    try {
      for await (const event of ClaudeStreamParser.parse(handle.stdout, podId, this.logger)) {
        for (const e of stderrEvents.splice(0)) yield e;
        // Update Claude pod ID on resume too
        if (event.type === 'status' && event.message.includes('Claude pod initialized')) {
          const match = event.message.match(/\(([^)]+)\)$/);
          if (match?.[1]) {
            this.claudeSessionIds.set(podId, match[1]);
          }
        }
        yield event;
      }
      for (const e of stderrEvents.splice(0)) yield e;
    } finally {
      this.handles.delete(podId);
    }
  }

  async abort(podId: string): Promise<void> {
    const handle = this.handles.get(podId);
    if (!handle) {
      this.logger.warn({
        component: 'claude-runtime',
        podId,
        msg: 'No exec handle found to abort',
      });
      return;
    }

    await handle.kill();
    this.handles.delete(podId);
    this.claudeSessionIds.delete(podId);
    this.mcpServersBySession.delete(podId);
  }

  async suspend(podId: string): Promise<void> {
    const handle = this.handles.get(podId);
    if (!handle) {
      this.logger.warn({
        component: 'claude-runtime',
        podId,
        msg: 'No exec handle found to suspend',
      });
      return;
    }

    this.logger.info({
      component: 'claude-runtime',
      podId,
      claudeSessionId: this.claudeSessionIds.get(podId),
      msg: 'Suspending claude pod (preserving pod ID for resume)',
    });

    await handle.kill();
    this.handles.delete(podId);
    // NOTE: claudeSessionIds is NOT deleted — that's the whole point of suspend vs abort
  }

  getClaudeSessionId(podId: string): string | undefined {
    return this.claudeSessionIds.get(podId);
  }

  setClaudeSessionId(podId: string, claudeSessionId: string): void {
    this.claudeSessionIds.set(podId, claudeSessionId);
  }

  /** Write MCP server config to a JSON file inside the container. */
  private async writeMcpConfig(
    containerId: string,
    mcpServers: SpawnConfig['mcpServers'],
  ): Promise<void> {
    if (!mcpServers || mcpServers.length === 0) return;

    const servers: Record<string, { type: string; url: string; headers?: Record<string, string> }> =
      {};
    for (const server of mcpServers) {
      servers[server.name] = {
        type: 'http',
        url: server.url,
        ...(server.headers && { headers: server.headers }),
      };
    }

    await this.containerManager.writeFile(
      containerId,
      MCP_CONFIG_PATH,
      JSON.stringify({ mcpServers: servers }, null, 2),
    );
  }

  private resolveModelId(model: string): string {
    const aliases: Record<string, string> = {
      opus: 'claude-opus-4-6',
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5',
    };
    return aliases[model] ?? model;
  }

  private buildSpawnArgs(config: SpawnConfig): string[] {
    const args = [
      '-p',
      config.task,
      '--model',
      this.resolveModelId(config.model),
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ];

    if (process.env.AUTOPOD_DEBUG_AGENT === '1') {
      args.push('--debug');
    }

    // Deterministic pod ID for tracking
    args.push('--pod-id', randomUUID());

    // Inject autopod system instructions without overwriting the repo's CLAUDE.md
    args.push('--append-system-prompt-file', AUTOPOD_INSTRUCTIONS_PATH);

    // MCP server configuration — the config file is pre-written to the container
    // by writeMcpConfig() before spawn. We just point Claude at the file path.
    if (config.mcpServers && config.mcpServers.length > 0) {
      args.push('--mcp-config', MCP_CONFIG_PATH);
    }

    return args;
  }

  private buildResumeArgs(
    message: string,
    claudeSessionId?: string,
    mcpServers?: SpawnConfig['mcpServers'],
  ): string[] {
    const args = [
      '-p',
      message,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ];

    if (process.env.AUTOPOD_DEBUG_AGENT === '1') {
      args.push('--debug');
    }

    // Inject autopod system instructions without overwriting the repo's CLAUDE.md
    args.push('--append-system-prompt-file', AUTOPOD_INSTRUCTIONS_PATH);

    // MCP config must be re-passed on resume — Claude Code doesn't persist it from the
    // initial spawn, so without this the escalation tools vanish after an ask_human round-trip.
    // The file is pre-written by writeMcpConfig() before this method is called.
    if (mcpServers && mcpServers.length > 0) {
      args.push('--mcp-config', MCP_CONFIG_PATH);
    }

    if (claudeSessionId) {
      args.push('--resume', claudeSessionId);
    }

    return args;
  }
}
