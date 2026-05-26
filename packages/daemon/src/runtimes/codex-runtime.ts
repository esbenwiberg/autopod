import { type Dirent, createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { CONTAINER_HOME_DIR } from '@autopod/shared';
import type { AgentEvent, Runtime, SpawnConfig } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import type { PodRepository } from '../pods/pod-repository.js';
import { codexStateDirForPod } from './codex-state-store.js';
import { CodexStreamParser } from './codex-stream-parser.js';
import {
  awaitExitCodeBounded,
  withIdleLivenessProbe,
  withPostCompleteGrace,
} from './stream-grace.js';

/** Path inside the container where Codex reads its config (including MCP servers). */
const MCP_CONFIG_PATH = `${CONTAINER_HOME_DIR}/.codex/config.toml`;
const EXTERNAL_SANDBOX_ARGS = ['--dangerously-bypass-approvals-and-sandbox'] as const;
// Codex defaults MCP tool calls to 120s. Autopod tools can legitimately block
// for human approval or long deploy scripts, so give the client a ceiling just
// above the daemon's default 1h human-response timeout.
const CODEX_MCP_TOOL_TIMEOUT_SEC = 3900;
const DEFAULT_ROLLOUT_POLL_MS = 1_000;

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;
const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl$/;

interface ParseStats {
  events: number;
  nonStatusEvents: number;
  sawComplete: boolean;
}

interface OutputState {
  events: number;
  nonStatusEvents: number;
  sawComplete: boolean;
}

interface RolloutCandidate {
  path: string;
  mtimeMs: number;
  size: number;
}

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
  /** Maps autopod podId → generated Autopod instructions for no-session resume fallback. */
  private customInstructionsBySession = new Map<string, string>();
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
    if (config.customInstructions?.trim()) {
      this.customInstructionsBySession.set(config.podId, config.customInstructions);
    } else {
      this.customInstructionsBySession.delete(config.podId);
    }

    const args = this.buildSpawnArgs(config);
    const taskIndex = args.length - 1;
    const safeSpawnArgs = args.map((a, i) => (i === taskIndex ? `<task: ${a.length} bytes>` : a));

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

    const outputState: OutputState = { events: 0, nonStatusEvents: 0, sawComplete: false };
    const enriched = this.parseWithRolloutFallback(handle, config.podId, outputState);

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
    } else if (!outputState.sawComplete || outputState.nonStatusEvents === 0) {
      yield {
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Codex exited successfully without JSON activity on stdout or rollout JSONL',
        fatal: false,
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

    const prompt = sessionId
      ? message
      : composePrompt(message, this.customInstructionsBySession.get(podId));
    const args = sessionId
      ? ['exec', 'resume', sessionId, ...EXTERNAL_SANDBOX_ARGS, '--json', prompt]
      : ['exec', ...EXTERNAL_SANDBOX_ARGS, '--json', prompt];

    // Redact the message from logs; Codex options must stay before the prompt.
    const messageIndex = args.length - 1;
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
        withIdleLivenessProbe(
          this.parseWithRolloutFallback(handle, podId, {
            events: 0,
            nonStatusEvents: 0,
            sawComplete: false,
          }),
          {
            streams: [handle.stdout, handle.stderr],
            runtimeName: 'codex-runtime',
            podId,
            logger: this.logger,
            containerManager: this.containerManager,
            containerId,
          },
        ),
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
    this.customInstructionsBySession.delete(podId);
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
    const args = ['exec'];
    if (config.model !== 'auto') {
      args.push('--model', config.model);
    }
    args.push(
      ...EXTERNAL_SANDBOX_ARGS,
      '--json',
      composePrompt(config.task, config.customInstructions),
    );
    return args;
  }

  private async *parseWithRolloutFallback(
    handle: StreamingExecResult,
    podId: string,
    outputState: OutputState,
  ): AsyncIterable<AgentEvent> {
    const seen = new Set<string>();
    const abortLiveRollout = new AbortController();
    const stdoutIterator = this.parseCodexLines(handle.stdout, podId, seen, outputState)[
      Symbol.asyncIterator
    ]();
    const rolloutIterator = this.pollLatestRollout(podId, abortLiveRollout.signal)[
      Symbol.asyncIterator
    ]();

    let stdoutStats: ParseStats = { events: 0, nonStatusEvents: 0, sawComplete: false };
    let stdoutDone = false;
    let stdoutNext = nextFrom('stdout', stdoutIterator);
    let rolloutNext = nextFrom('rollout', rolloutIterator);

    try {
      while (!stdoutDone) {
        const next = await Promise.race([stdoutNext, rolloutNext]);
        if (next.source === 'stdout') {
          if (next.result.done) {
            const readyRollout = await settledOrNull(rolloutNext);
            if (readyRollout && !readyRollout.result.done) {
              const event = readyRollout.result.value;
              const key = dedupeKey(event);
              if (!seen.has(key)) {
                seen.add(key);
                recordOutputEvent(outputState, event);
                yield event;
              }
              rolloutNext = nextFrom('rollout', rolloutIterator);
              continue;
            }
            stdoutDone = true;
            stdoutStats = next.result.value;
          } else {
            yield next.result.value;
            stdoutNext = nextFrom('stdout', stdoutIterator);
          }
        } else if (next.result.done) {
          rolloutNext = neverSettles<'rollout'>();
        } else {
          const event = next.result.value;
          const key = dedupeKey(event);
          if (seen.has(key)) {
            rolloutNext = nextFrom('rollout', rolloutIterator);
            continue;
          }
          seen.add(key);
          recordOutputEvent(outputState, event);
          yield event;
          rolloutNext = nextFrom('rollout', rolloutIterator);
        }
      }
    } finally {
      abortLiveRollout.abort();
      await rolloutIterator.return?.();
    }

    if (stdoutStats.sawComplete && stdoutStats.nonStatusEvents > 0) return;

    yield* this.replayLatestRollout(podId, seen, stdoutStats, outputState);
  }

  private async *parseCodexLines(
    lines: Readable,
    podId: string,
    seen: Set<string>,
    outputState: OutputState,
  ): AsyncGenerator<AgentEvent, ParseStats, void> {
    const iterator = this.parseCodexLinesRaw(lines, podId)[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done) return next.value;

      const event = next.value;
      const key = dedupeKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      recordOutputEvent(outputState, event);
      yield event;
    }
  }

  private async *parseCodexLinesRaw(
    lines: Readable,
    podId: string,
  ): AsyncGenerator<AgentEvent, ParseStats, void> {
    const stats: ParseStats = { events: 0, nonStatusEvents: 0, sawComplete: false };

    for await (const event of CodexStreamParser.parse(lines, podId, this.logger)) {
      stats.events += 1;
      if (event.type !== 'status') stats.nonStatusEvents += 1;
      if (event.type === 'complete') stats.sawComplete = true;
      if (event.type === 'status' && event.sessionId) {
        this.codexSessionIds.set(podId, event.sessionId);
      }

      yield event;
    }

    return stats;
  }

  private async *replayLatestRollout(
    podId: string,
    seen: Set<string>,
    stdoutStats: ParseStats,
    outputState: OutputState,
  ): AsyncGenerator<AgentEvent, ParseStats, void> {
    const rolloutPath = await findLatestCodexRolloutFile(codexStateDirForPod(podId));
    if (!rolloutPath) {
      this.logger.warn(
        {
          component: 'codex-runtime',
          podId,
          stdoutEvents: stdoutStats.events,
          stdoutNonStatusEvents: stdoutStats.nonStatusEvents,
          stdoutSawComplete: stdoutStats.sawComplete,
        },
        'Codex stdout stream ended without complete activity and no rollout JSONL was found',
      );
      return { events: 0, nonStatusEvents: 0, sawComplete: false };
    }

    this.logger.warn(
      {
        component: 'codex-runtime',
        podId,
        rolloutPath,
        stdoutEvents: stdoutStats.events,
        stdoutNonStatusEvents: stdoutStats.nonStatusEvents,
        stdoutSawComplete: stdoutStats.sawComplete,
      },
      'Codex stdout stream ended without complete activity — replaying rollout JSONL',
    );

    return yield* this.parseCodexLines(createReadStream(rolloutPath), podId, seen, outputState);
  }

  private async *pollLatestRollout(
    podId: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, void, void> {
    let lastSignature: string | null = null;

    while (!signal.aborted) {
      try {
        const rollout = await findLatestCodexRollout(codexStateDirForPod(podId));
        if (rollout) {
          const signature = `${rollout.path}:${rollout.mtimeMs}:${rollout.size}`;
          if (signature !== lastSignature) {
            lastSignature = signature;
            yield* this.parseCodexLinesRaw(createReadStream(rollout.path), podId);
          }
        }
      } catch (err) {
        this.logger.warn(
          { component: 'codex-runtime', podId, err },
          'Failed to poll Codex rollout JSONL',
        );
      }

      await sleep(rolloutPollIntervalMs(), signal);
    }
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
      lines.push(`tool_timeout_sec = ${CODEX_MCP_TOOL_TIMEOUT_SEC.toFixed(1)}`);
      sections.push(lines.join('\n'));
    }

    await this.containerManager.writeFile(
      containerId,
      MCP_CONFIG_PATH,
      `${sections.join('\n\n')}\n`,
    );
  }
}

function composePrompt(task: string, customInstructions?: string): string {
  const instructions = customInstructions?.trim();
  if (!instructions) return task;
  return [
    instructions,
    '',
    '---',
    '',
    '## Current Codex Turn',
    '',
    'Follow the Autopod workflow requirements above while handling this current request:',
    '',
    task,
  ].join('\n');
}

function dedupeKey(event: AgentEvent): string {
  return JSON.stringify(event);
}

function recordOutputEvent(state: OutputState, event: AgentEvent): void {
  state.events += 1;
  if (event.type !== 'status') state.nonStatusEvents += 1;
  if (event.type === 'complete') state.sawComplete = true;
}

function nextFrom<Source extends 'stdout' | 'rollout'>(
  source: Source,
  iterator: AsyncIterator<AgentEvent, Source extends 'stdout' ? ParseStats : void>,
): Promise<{
  source: Source;
  result: IteratorResult<AgentEvent, Source extends 'stdout' ? ParseStats : void>;
}> {
  return iterator.next().then((result) => ({ source, result }));
}

function neverSettles<Source extends 'stdout' | 'rollout'>(): Promise<{
  source: Source;
  result: IteratorResult<AgentEvent, Source extends 'stdout' ? ParseStats : void>;
}> {
  return new Promise(() => {});
}

function settledOrNull<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([promise, Promise.resolve(null)]);
}

function rolloutPollIntervalMs(): number {
  const configured = Number.parseInt(
    process.env.AUTOPOD_CODEX_ROLLOUT_POLL_MS ?? `${DEFAULT_ROLLOUT_POLL_MS}`,
    10,
  );
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ROLLOUT_POLL_MS;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function findLatestCodexRolloutFile(rootDir: string): Promise<string | null> {
  const latest = await findLatestCodexRollout(rootDir);
  return latest?.path ?? null;
}

async function findLatestCodexRollout(rootDir: string): Promise<RolloutCandidate | null> {
  const candidates: RolloutCandidate[] = [];
  await collectRolloutFiles(rootDir, candidates);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ?? null;
}

async function collectRolloutFiles(dir: string, candidates: RolloutCandidate[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRolloutFiles(entryPath, candidates);
      continue;
    }
    if (!entry.isFile() || !ROLLOUT_FILE_RE.test(entry.name)) continue;
    const info = await stat(entryPath);
    candidates.push({ path: entryPath, mtimeMs: info.mtimeMs, size: info.size });
  }
}
