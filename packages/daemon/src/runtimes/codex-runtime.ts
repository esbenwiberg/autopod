import type { Runtime, SpawnConfig, AgentEvent } from '@autopod/shared';
import type { Logger } from 'pino';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { CodexStreamParser } from './codex-stream-parser.js';

const ABORT_GRACE_PERIOD_MS = 5_000;

type SpawnFn = typeof nodeSpawn;

export class CodexRuntime implements Runtime {
  readonly type = 'codex' as const;

  private processes = new Map<string, ChildProcess>();
  private logger: Logger;
  private spawnFn: SpawnFn;

  constructor(logger: Logger, spawnFn: SpawnFn = nodeSpawn) {
    this.logger = logger;
    this.spawnFn = spawnFn;
  }

  async *spawn(config: SpawnConfig): AsyncIterable<AgentEvent> {
    const args = this.buildSpawnArgs(config);

    this.logger.info({
      component: 'codex-runtime',
      sessionId: config.sessionId,
      args,
      msg: 'Spawning codex process',
    });

    const proc = this.spawnFn('codex', args, {
      cwd: config.workDir,
      env: {
        ...process.env,
        ...config.env,
        // Codex CLI uses OPENAI_API_KEY from env
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.set(config.sessionId, proc);

    try {
      yield* CodexStreamParser.parse(proc.stdout!, config.sessionId, this.logger);
    } finally {
      this.processes.delete(config.sessionId);
    }

    // Check exit code after stream is consumed
    const exitCode = await this.waitForExit(proc);
    if (exitCode !== 0) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `Codex process exited with code ${exitCode}`,
        fatal: true,
      };
    }
  }

  async *resume(sessionId: string, message: string): AsyncIterable<AgentEvent> {
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
      msg: 'Resuming codex with follow-up message',
    });

    const proc = this.spawnFn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.set(sessionId, proc);

    try {
      yield* CodexStreamParser.parse(proc.stdout!, sessionId, this.logger);
    } finally {
      this.processes.delete(sessionId);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId);
    if (!proc) {
      this.logger.warn({
        component: 'codex-runtime',
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
          component: 'codex-runtime',
          sessionId,
          msg: 'Codex process did not exit after SIGTERM, sent SIGKILL',
        });
      }
    }, ABORT_GRACE_PERIOD_MS);

    await this.waitForExit(proc);
    clearTimeout(killTimeout);
    this.processes.delete(sessionId);
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
