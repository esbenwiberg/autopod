import type { Runtime, SpawnConfig, AgentEvent } from '@autopod/shared';
import type { Logger } from 'pino';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ClaudeStreamParser } from './claude-stream-parser.js';

const ABORT_GRACE_PERIOD_MS = 5_000;

type SpawnFn = typeof nodeSpawn;

/**
 * Claude CLI runtime adapter.
 *
 * Spawns `claude` CLI with `--output-format stream-json` and parses
 * the NDJSON output via ClaudeStreamParser. Mirrors CodexRuntime pattern.
 */
export class ClaudeRuntime implements Runtime {
  readonly type = 'claude' as const;

  private processes = new Map<string, ChildProcess>();
  /** Maps autopod sessionId → Claude CLI session_id for resume support. */
  private claudeSessionIds = new Map<string, string>();
  private logger: Logger;
  private spawnFn: SpawnFn;

  constructor(logger: Logger, spawnFn: SpawnFn = nodeSpawn) {
    this.logger = logger;
    this.spawnFn = spawnFn;
  }

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    const args = this.buildSpawnArgs(config);

    this.logger.info({
      component: 'claude-runtime',
      sessionId: config.sessionId,
      args,
      msg: 'Spawning claude process',
    });

    const proc = this.spawnFn('claude', args, {
      cwd: config.workDir,
      env: {
        ...process.env,
        ...config.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.set(config.sessionId, proc);

    if (!proc.stdout) {
      throw new Error('Claude process stdout not available');
    }

    try {
      for await (const event of ClaudeStreamParser.parse(proc.stdout, config.sessionId, this.logger)) {
        // Capture Claude's session ID from init events for resume support
        if (event.type === 'status' && event.message.includes('Claude session initialized')) {
          const match = event.message.match(/\(([^)]+)\)$/);
          if (match?.[1]) {
            this.claudeSessionIds.set(config.sessionId, match[1]);
          }
        }
        yield event;
      }
    } finally {
      this.processes.delete(config.sessionId);
    }

    // Check exit code after stream is consumed
    const exitCode = await this.waitForExit(proc);
    if (exitCode !== 0) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `Claude process exited with code ${exitCode}`,
        fatal: true,
      };
    }
  }

  async *resume(sessionId: string, message: string): AsyncIterable<AgentEvent> {
    const claudeSessionId = this.claudeSessionIds.get(sessionId);
    const args = this.buildResumeArgs(message, claudeSessionId);

    this.logger.info({
      component: 'claude-runtime',
      sessionId,
      claudeSessionId,
      msg: 'Resuming claude session',
    });

    const proc = this.spawnFn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.set(sessionId, proc);

    if (!proc.stdout) {
      throw new Error('Claude process stdout not available');
    }

    try {
      for await (const event of ClaudeStreamParser.parse(proc.stdout, sessionId, this.logger)) {
        // Update Claude session ID on resume too
        if (event.type === 'status' && event.message.includes('Claude session initialized')) {
          const match = event.message.match(/\(([^)]+)\)$/);
          if (match?.[1]) {
            this.claudeSessionIds.set(sessionId, match[1]);
          }
        }
        yield event;
      }
    } finally {
      this.processes.delete(sessionId);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId);
    if (!proc) {
      this.logger.warn({
        component: 'claude-runtime',
        sessionId,
        msg: 'No process found to abort',
      });
      return;
    }

    // Graceful shutdown: SIGTERM first, SIGKILL after timeout
    proc.kill('SIGTERM');

    const killTimeout = setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
        this.logger.warn({
          component: 'claude-runtime',
          sessionId,
          msg: 'Claude process did not exit after SIGTERM, sent SIGKILL',
        });
      }
    }, ABORT_GRACE_PERIOD_MS);

    await this.waitForExit(proc);
    clearTimeout(killTimeout);
    this.processes.delete(sessionId);
    this.claudeSessionIds.delete(sessionId);
  }

  private buildSpawnArgs(config: SpawnConfig): string[] {
    const args = [
      '-p', config.task,
      '--model', config.model,
      '--output-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
    ];

    // Deterministic session ID for tracking
    args.push('--session-id', randomUUID());

    // MCP server configuration
    if (config.mcpServers && config.mcpServers.length > 0) {
      const mcpConfig: Record<string, { url: string; headers?: Record<string, string> }> = {};
      for (const server of config.mcpServers) {
        mcpConfig[server.name] = {
          url: server.url,
          ...(server.headers && { headers: server.headers }),
        };
      }
      args.push('--mcp-config', JSON.stringify(mcpConfig));
    }

    return args;
  }

  private buildResumeArgs(message: string, claudeSessionId?: string): string[] {
    const args = [
      '-p', message,
      '--output-format', 'stream-json',
      '--permission-mode', 'bypassPermissions',
    ];

    if (claudeSessionId) {
      args.push('--resume', claudeSessionId);
    }

    return args;
  }

  private waitForExit(proc: ChildProcess): Promise<number> {
    return new Promise((resolve) => {
      if (proc.exitCode !== null) {
        resolve(proc.exitCode);
        return;
      }
      proc.on('exit', (code) => resolve(code ?? 1));
    });
  }
}
