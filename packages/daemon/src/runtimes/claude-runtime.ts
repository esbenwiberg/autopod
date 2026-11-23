import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ReasoningEffort,
  Runtime,
  RuntimeEvent,
  SpawnConfig,
} from '@autopod/shared';
import {
  AUTOPOD_INSTRUCTIONS_PATH,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_REVIEWER_MODEL,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { ClaudeStreamParser } from './claude-stream-parser.js';
import {
  type ClaudeTurnVerdict,
  createClaudeTurnFinality,
  describeInterruptedClaudeTurn,
} from './claude-turn-finality.js';
import { withObservedRuntimeExit } from './observed-runtime-exit.js';
import { withIdleLivenessProbe } from './stream-grace.js';

/** Path inside the container where the MCP config JSON is written. */
const MCP_CONFIG_PATH = '/home/autopod/.autopod/mcp-config.json';

/**
 * Substring Claude CLI emits to stderr when `--resume <id>` finds no matching
 * conversation history on disk. Surfaces as e.g.
 *   "No conversation found with session ID: 07d2bb1d-…"
 * We detect this so pod-manager can fall back to a fresh spawn instead of
 * letting the agent process exit silently with no work done.
 */
const RESUME_SESSION_NOT_FOUND_MARKER = 'No conversation found with session ID';

/**
 * Thrown from `resume()` when Claude CLI reports the persisted session ID does
 * not exist in the container's local history (typically because the container
 * was respawned without a persistent `~/.claude/projects/` mount). Pod-manager
 * catches this and retries with a fresh spawn carrying recovery context.
 */
export class ResumeSessionNotFoundError extends Error {
  readonly podId: string;
  readonly claudeSessionId: string | undefined;
  constructor(podId: string, claudeSessionId: string | undefined) {
    super(
      `Claude --resume failed: no conversation found for session ${claudeSessionId ?? '<unknown>'}`,
    );
    this.name = 'ResumeSessionNotFoundError';
    this.podId = podId;
    this.claudeSessionId = claudeSessionId;
  }
}

export interface ClaudeRuntimeOptions {
  /**
   * Whether a turn that ends with background work pending may wait (bounded) for
   * the CLI to continue. Wired to "pod running without a pending human decision":
   * while a human is awaited, holding the run open would only queue the reply.
   * Defaults to always.
   */
  awaitBackgroundTasks?: (podId: string) => boolean;
}

interface ClaudeInvocationResult {
  exitCode: number;
  /** The daemon had to terminate the process tree to observe the exit. */
  terminated: boolean;
  verdict: ClaudeTurnVerdict;
  sessionNotFound: boolean;
}

/**
 * Claude CLI runtime adapter.
 *
 * Runs `claude` CLI inside a Docker container via `containerManager.execStreaming()`
 * and parses the NDJSON output via ClaudeStreamParser.
 */
export class ClaudeRuntime implements Runtime {
  readonly type = 'claude' as const;

  private handles = new Map<string, StreamingExecResult>();
  /** Maps autopod podId → Claude CLI session_id (the `--resume` arg). */
  private claudeSessionIds = new Map<string, string>();
  /** Maps autopod podId → MCP servers so resume() can re-write the config into the new container. */
  private mcpServersBySession = new Map<string, SpawnConfig['mcpServers']>();
  /** Maps autopod podId → portable effort so resume() preserves the initial invocation. */
  private reasoningEffortBySession = new Map<string, ReasoningEffort>();
  private logger: Logger;
  private containerManager: ContainerManager;
  private options: ClaudeRuntimeOptions;

  constructor(
    logger: Logger,
    containerManager: ContainerManager,
    options: ClaudeRuntimeOptions = {},
  ) {
    this.logger = logger;
    this.containerManager = containerManager;
    this.options = options;
  }

  async *spawn(config: SpawnConfig): AsyncIterable<RuntimeEvent> {
    // A fresh segment must not expose an earlier resource's native session.
    this.claudeSessionIds.delete(config.podId);
    // Write MCP config to a file inside the container so Claude CLI can read it
    // via --mcp-config <path>. Passing inline JSON breaks due to shell escaping
    // inside containerManager.execStreaming().
    await this.writeMcpConfig(config.containerId, config.mcpServers);
    this.mcpServersBySession.set(config.podId, config.mcpServers);
    this.reasoningEffortBySession.set(config.podId, config.reasoningEffort);

    const args = this.buildSpawnArgs(config);
    const safeArgs = args.map((a, i) => (i === args.length - 1 ? `<task: ${a.length} bytes>` : a));

    this.logger.info({
      component: 'claude-runtime',
      podId: config.podId,
      containerId: config.containerId,
      args: safeArgs,
      msg: 'Spawning claude in container',
    });

    // Use the agent shim so *_FILE env vars are expanded before claude starts.
    // This keeps raw API keys out of the exec's initial environment.
    const shimPath = '/run/autopod/agent-shim.sh';
    const handle = await this.containerManager.execStreaming(
      config.containerId,
      ['sh', shimPath, 'claude', ...args],
      { cwd: config.workDir, env: config.env },
    );

    this.handles.set(config.podId, handle);

    try {
      const run = yield* this.runInvocation(config.podId, config.containerId, handle);
      yield* this.exitEvents(config.podId, run);
    } finally {
      if (this.handles.get(config.podId) === handle) this.handles.delete(config.podId);
    }
  }

  async *resume(
    podId: string,
    message: string,
    containerId: string,
    env?: Record<string, string>,
  ): AsyncIterable<RuntimeEvent> {
    const claudeSessionId = this.claudeSessionIds.get(podId);
    // Re-write the MCP config into the (potentially new) container before launching Claude.
    // Without this, recovery spawns a fresh container that never has the config file, causing
    // Claude to error immediately and exit — which then breaks smoke-test execs with 409.
    const mcpServers = this.mcpServersBySession.get(podId);
    await this.writeMcpConfig(containerId, mcpServers);
    const args = this.buildResumeArgs(
      message,
      claudeSessionId,
      mcpServers,
      this.reasoningEffortBySession.get(podId),
    );

    this.logger.info({
      component: 'claude-runtime',
      podId,
      containerId,
      claudeSessionId,
      msg: 'Resuming claude pod in container',
    });

    const shimPath = '/run/autopod/agent-shim.sh';
    const handle = await this.containerManager.execStreaming(
      containerId,
      ['sh', shimPath, 'claude', ...args],
      {
        cwd: '/workspace',
        ...(env ? { env } : {}),
      },
    );

    this.handles.set(podId, handle);

    // Only hand off to a fresh spawn after the missing-session process exits.
    try {
      const run = yield* this.runInvocation(podId, containerId, handle, claudeSessionId);
      if (run.sessionNotFound) {
        this.claudeSessionIds.delete(podId);
        throw new ResumeSessionNotFoundError(podId, claudeSessionId);
      }
      yield* this.exitEvents(podId, run);
    } finally {
      if (this.handles.get(podId) === handle) this.handles.delete(podId);
    }
  }

  /**
   * One CLI invocation: parse stdout, interleave stderr, capture the native
   * session id, decide turn finality (#648), and observe (or verifiably force)
   * the process exit.
   */
  private async *runInvocation(
    podId: string,
    containerId: string,
    handle: StreamingExecResult,
    resumedSessionId?: string,
  ): AsyncGenerator<RuntimeEvent, ClaudeInvocationResult> {
    let sessionNotFound = false;
    const observeDiagnostic = (text: unknown) => {
      if (
        resumedSessionId &&
        typeof text === 'string' &&
        text.includes(`${RESUME_SESSION_NOT_FOUND_MARKER}: ${resumedSessionId}`)
      )
        sessionNotFound = true;
    };
    // Emit stderr lines in real-time as error events so they appear in the TUI immediately
    const stderrEvents: AgentEvent[] = [];
    handle.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (!text) return;
      observeDiagnostic(text);
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

    const finality = createClaudeTurnFinality({
      podId,
      logger: this.logger,
      streams: [handle.stdout, handle.stderr],
      awaitBackground: () => this.options.awaitBackgroundTasks?.(podId) ?? true,
    });
    const claudeSessionIds = this.claudeSessionIds;
    const podLogger = this.logger;
    const enriched = (async function* parseWithEnrichments(): AsyncIterable<RuntimeEvent> {
      const parsed = ClaudeStreamParser.parse(
        handle.stdout,
        podId,
        podLogger,
        (raw) => {
          finality.observeRaw(raw);
          if (raw.type === 'result' && raw.is_error && Array.isArray(raw.errors))
            for (const diagnostic of raw.errors) observeDiagnostic(diagnostic);
        },
        resumedSessionId,
      );
      for await (const event of finality.wrap(parsed)) {
        // Flush any stderr events that arrived before the next stdout event
        for (const e of stderrEvents.splice(0)) yield e;
        // Newer CLIs emit a zero-usage error result as well as stderr on a
        // missing session. Do not seed its cursor or give the consumer a fatal
        // event that stops it before the verified-exit fallback can run.
        if (sessionNotFound && (event.type === 'claude_result_usage' || event.type === 'error'))
          continue;
        // Capture Claude's session ID from init events for resume support
        if (event.type === 'status' && event.sessionId)
          claudeSessionIds.set(podId, event.sessionId);
        yield event;
      }
      // Flush any remaining stderr events after stdout closes
      for (const e of stderrEvents.splice(0)) yield e;
    })();

    const lifecycle = { terminated: false };
    const exitCode = yield* withObservedRuntimeExit(
      withIdleLivenessProbe(enriched, {
        streams: [handle.stdout, handle.stderr],
        runtimeName: 'claude-runtime',
        podId,
        logger: this.logger,
        containerManager: this.containerManager,
        containerId,
      }),
      handle.exitCode,
      this.observedExitOptions(podId, handle, lifecycle),
    );
    return {
      exitCode,
      terminated: lifecycle.terminated,
      verdict: finality.verdict(),
      sessionNotFound,
    };
  }

  /**
   * The CLI can outlive its final result: Claude keeps running while tool
   * processes it started in the background (Bash `run_in_background`, Monitor)
   * are alive. When the exit is not observed in time, terminate the CLI's whole
   * process tree inside the container and then observe the exit — termination
   * stays verified instead of being abandoned as unknown.
   */
  private observedExitOptions(
    podId: string,
    handle: StreamingExecResult,
    lifecycle: { terminated: boolean },
  ) {
    return {
      runtimeName: 'claude-runtime',
      podId,
      logger: this.logger,
      terminate: () => handle.kill(),
      onTerminated: () => {
        lifecycle.terminated = true;
      },
    };
  }

  private *exitEvents(podId: string, run: ClaudeInvocationResult): Generator<AgentEvent> {
    const { exitCode, terminated, verdict } = run;
    const interrupted = describeInterruptedClaudeTurn(verdict, exitCode, podId);
    if (interrupted) {
      // Never report an unfinished turn as completed (#648).
      // Observed result usage has already been forwarded; exit is now verified.
      this.logger.warn(
        { component: 'claude-runtime', podId, exitCode, verdict: verdict.kind },
        'Claude turn interrupted before it finished',
      );
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: interrupted,
        fatal: true,
        turnInterrupted: true,
      };
      return;
    }
    if (exitCode === 0) return;
    if (terminated && verdict.kind === 'final') {
      // The turn finished; only processes it left behind blocked the exit.
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: `Claude did not exit after its final result (background processes still running); the daemon terminated its process tree and observed exit code ${exitCode}. Completed turn retained.`,
        fatal: false,
      };
      return;
    }
    yield {
      type: 'error',
      timestamp: new Date().toISOString(),
      message: `Claude process exited with code ${exitCode}`,
      fatal: true,
    };
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
    this.reasoningEffortBySession.delete(podId);
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

  setClaudeResumeConfig(
    podId: string,
    mcpServers: SpawnConfig['mcpServers'],
    reasoningEffort: ReasoningEffort,
  ): void {
    this.mcpServersBySession.set(podId, mcpServers);
    this.reasoningEffortBySession.set(podId, reasoningEffort);
  }

  /**
   * Write MCP server config to a JSON file inside the container.
   *
   * Both http and stdio transports go through this single config — keeping the
   * file outside /workspace means daemon-injected tooling (serena, roslyn-codelens)
   * can never be picked up by `git add` and committed to the repo.
   */
  private async writeMcpConfig(
    containerId: string,
    mcpServers: SpawnConfig['mcpServers'],
  ): Promise<void> {
    if (!mcpServers || mcpServers.length === 0) return;

    const servers: Record<string, Record<string, unknown>> = {};
    for (const server of mcpServers) {
      if (server.type === 'stdio') {
        servers[server.name] = {
          type: 'stdio',
          command: server.command,
          ...(server.args && { args: server.args }),
          ...(server.env && { env: server.env }),
        };
      } else {
        servers[server.name] = {
          type: 'http',
          url: server.url,
          ...(server.headers && { headers: server.headers }),
        };
      }
    }

    await this.containerManager.writeFile(
      containerId,
      MCP_CONFIG_PATH,
      JSON.stringify({ mcpServers: servers }, null, 2),
    );
  }

  private resolveModelId(model: string): string {
    const aliases: Record<string, string> = {
      opus: CLAUDE_DEFAULT_MODEL,
      sonnet: CLAUDE_REVIEWER_MODEL,
      haiku: 'claude-haiku-4-5',
    };
    return aliases[model] ?? model;
  }

  private buildSpawnArgs(config: SpawnConfig): string[] {
    const args = [
      '-p',
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
    if (config.reasoningEffort !== 'auto') {
      args.push('--effort', config.reasoningEffort);
    }

    // Deterministic Claude CLI session ID for tracking (Claude CLI flag name — not autopod's pod ID)
    args.push('--session-id', randomUUID());

    // Inject autopod system instructions without overwriting the repo's CLAUDE.md
    args.push('--append-system-prompt-file', AUTOPOD_INSTRUCTIONS_PATH);

    // MCP server configuration — the config file is pre-written to the container
    // by writeMcpConfig() before spawn. We just point Claude at the file path.
    if (config.mcpServers && config.mcpServers.length > 0) {
      args.push('--mcp-config', MCP_CONFIG_PATH);
    }

    // '--' signals end-of-options to Commander so the task string is always
    // treated as a positional prompt, even when it starts with '---' (e.g. YAML
    // front-matter in brief files).
    args.push('--', config.task);

    return args;
  }

  private buildResumeArgs(
    message: string,
    claudeSessionId?: string,
    mcpServers?: SpawnConfig['mcpServers'],
    reasoningEffort?: ReasoningEffort,
  ): string[] {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ];

    if (process.env.AUTOPOD_DEBUG_AGENT === '1') {
      args.push('--debug');
    }
    if (reasoningEffort && reasoningEffort !== 'auto') {
      args.push('--effort', reasoningEffort);
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

    // '--' signals end-of-options so the message is always treated as a positional
    // prompt, even when it starts with dashes (e.g. YAML front-matter).
    args.push('--', message);

    return args;
  }
}
