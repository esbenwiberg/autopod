import { randomUUID } from 'node:crypto';
import type { AgentEvent, Runtime, SpawnConfig } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { ClaudeStreamParser } from './claude-stream-parser.js';

/**
 * Claude CLI runtime adapter.
 *
 * Runs `claude` CLI inside a Docker container via `containerManager.execStreaming()`
 * and parses the NDJSON output via ClaudeStreamParser.
 */
export class ClaudeRuntime implements Runtime {
  readonly type = 'claude' as const;

  private handles = new Map<string, StreamingExecResult>();
  /** Maps autopod sessionId → Claude CLI session_id for resume support. */
  private claudeSessionIds = new Map<string, string>();
  private logger: Logger;
  private containerManager: ContainerManager;

  constructor(logger: Logger, containerManager: ContainerManager) {
    this.logger = logger;
    this.containerManager = containerManager;
  }

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    const args = this.buildSpawnArgs(config);

    this.logger.info({
      component: 'claude-runtime',
      sessionId: config.sessionId,
      containerId: config.containerId,
      args,
      msg: 'Spawning claude in container',
    });

    const handle = await this.containerManager.execStreaming(
      config.containerId,
      ['claude', ...args],
      { cwd: config.workDir, env: config.env },
    );

    this.handles.set(config.sessionId, handle);

    // Emit stderr lines in real-time as error events so they appear in the TUI immediately
    const stderrEvents: AgentEvent[] = [];
    handle.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (!text) return;
      this.logger.warn(
        { component: 'claude-runtime', sessionId: config.sessionId, stderr: text.slice(0, 500) },
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
        config.sessionId,
        this.logger,
      )) {
        // Flush any stderr events that arrived before the next stdout event
        for (const e of stderrEvents.splice(0)) yield e;

        // Capture Claude's session ID from init events for resume support
        if (event.type === 'status' && event.message.includes('Claude session initialized')) {
          const match = event.message.match(/\(([^)]+)\)$/);
          if (match?.[1]) {
            this.claudeSessionIds.set(config.sessionId, match[1]);
          }
        }
        yield event;
      }
      // Flush any remaining stderr events after stdout closes
      for (const e of stderrEvents.splice(0)) yield e;
    } finally {
      this.handles.delete(config.sessionId);
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
    sessionId: string,
    message: string,
    containerId: string,
    env?: Record<string, string>,
  ): AsyncIterable<AgentEvent> {
    const claudeSessionId = this.claudeSessionIds.get(sessionId);
    const args = this.buildResumeArgs(message, claudeSessionId);

    this.logger.info({
      component: 'claude-runtime',
      sessionId,
      containerId,
      claudeSessionId,
      msg: 'Resuming claude session in container',
    });

    const handle = await this.containerManager.execStreaming(containerId, ['claude', ...args], {
      cwd: '/workspace',
      ...(env ? { env } : {}),
    });

    this.handles.set(sessionId, handle);

    const stderrEvents: AgentEvent[] = [];
    handle.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (!text) return;
      this.logger.warn(
        { component: 'claude-runtime', sessionId, stderr: text.slice(0, 500) },
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
      for await (const event of ClaudeStreamParser.parse(handle.stdout, sessionId, this.logger)) {
        for (const e of stderrEvents.splice(0)) yield e;
        // Update Claude session ID on resume too
        if (event.type === 'status' && event.message.includes('Claude session initialized')) {
          const match = event.message.match(/\(([^)]+)\)$/);
          if (match?.[1]) {
            this.claudeSessionIds.set(sessionId, match[1]);
          }
        }
        yield event;
      }
      for (const e of stderrEvents.splice(0)) yield e;
    } finally {
      this.handles.delete(sessionId);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      this.logger.warn({
        component: 'claude-runtime',
        sessionId,
        msg: 'No exec handle found to abort',
      });
      return;
    }

    await handle.kill();
    this.handles.delete(sessionId);
    this.claudeSessionIds.delete(sessionId);
  }

  async suspend(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      this.logger.warn({
        component: 'claude-runtime',
        sessionId,
        msg: 'No exec handle found to suspend',
      });
      return;
    }

    this.logger.info({
      component: 'claude-runtime',
      sessionId,
      claudeSessionId: this.claudeSessionIds.get(sessionId),
      msg: 'Suspending claude session (preserving session ID for resume)',
    });

    await handle.kill();
    this.handles.delete(sessionId);
    // NOTE: claudeSessionIds is NOT deleted — that's the whole point of suspend vs abort
  }

  getClaudeSessionId(sessionId: string): string | undefined {
    return this.claudeSessionIds.get(sessionId);
  }

  setClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    this.claudeSessionIds.set(sessionId, claudeSessionId);
  }

  private buildSpawnArgs(config: SpawnConfig): string[] {
    const args = [
      '-p',
      config.task,
      '--model',
      config.model,
      '--output-format',
      'stream-json',
      '--permission-mode',
      'bypassPermissions',
    ];

    // Only add verbose/debug when explicitly requested — on long sessions these flags
    // bloat the conversation context, compounding API latency on every subsequent turn.
    if (process.env.AUTOPOD_DEBUG_AGENT === '1') {
      args.push('--verbose', '--debug');
    }

    // Deterministic session ID for tracking
    args.push('--session-id', randomUUID());

    // MCP server configuration
    if (config.mcpServers && config.mcpServers.length > 0) {
      const servers: Record<
        string,
        { type: string; url: string; headers?: Record<string, string> }
      > = {};
      for (const server of config.mcpServers) {
        servers[server.name] = {
          type: 'http',
          url: server.url,
          ...(server.headers && { headers: server.headers }),
        };
      }
      args.push('--mcp-config', JSON.stringify({ mcpServers: servers }));
    }

    return args;
  }

  private buildResumeArgs(message: string, claudeSessionId?: string): string[] {
    const args = [
      '-p',
      message,
      '--output-format',
      'stream-json',
      '--permission-mode',
      'bypassPermissions',
    ];

    if (process.env.AUTOPOD_DEBUG_AGENT === '1') {
      args.push('--verbose', '--debug');
    }

    if (claudeSessionId) {
      args.push('--resume', claudeSessionId);
    }

    return args;
  }
}
