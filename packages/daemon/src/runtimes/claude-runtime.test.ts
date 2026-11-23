import { PassThrough } from 'node:stream';
import type { AgentErrorEvent, RuntimeEvent, SpawnConfig } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { ClaudeRuntime, ResumeSessionNotFoundError } from './claude-runtime.js';

const logger = pino({ level: 'silent' });

function createMockHandle(options?: { exitCode?: number }): StreamingExecResult & {
  finish(code?: number): void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExitCode: (code: number) => void;
  const exitCodePromise = new Promise<number>((resolve) => {
    resolveExitCode = resolve;
  });

  const handle = {
    stdout,
    stderr,
    exitCode: exitCodePromise,
    kill: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
      resolveExitCode?.(options?.exitCode ?? 137);
    }),
    finish(code?: number) {
      stdout.push(null);
      resolveExitCode?.(code ?? options?.exitCode ?? 0);
    },
  };

  return handle;
}

function createMockContainerManager(handle: StreamingExecResult): ContainerManager {
  return {
    spawn: vi.fn(async () => 'container-123'),
    kill: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    refreshFirewall: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ''),
    getStatus: vi.fn(async () => 'running' as const),
    execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    execStreaming: vi.fn(async () => handle),
  };
}

/** Emit a single Claude NDJSON line onto stdout. */
function emitLine(stdout: PassThrough, obj: unknown) {
  stdout.write(`${JSON.stringify(obj)}\n`);
}

describe('ClaudeRuntime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.AUTOPOD_DEBUG_AGENT = undefined;
  });

  // ---------------------------------------------------------------------------
  // buildSpawnArgs
  // ---------------------------------------------------------------------------

  describe('buildSpawnArgs', () => {
    it('includes required flags', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        podId: 'abc',
        task: 'Add a test',
        model: 'claude-opus-4-5',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
      });

      expect(args).toContain('-p');
      expect(args).toContain('Add a test');
      expect(args).toContain('--model');
      expect(args).toContain('claude-opus-4-5');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--permission-mode');
      expect(args).toContain('bypassPermissions');
      expect(args).toContain('--append-system-prompt-file');
      expect(args).toContain('/home/autopod/.autopod/system-instructions.md');
    });

    it('keeps Claude 5 canonical IDs and resolves defensive aliases to current defaults', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const buildArgs = (model: string) =>
        (
          runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
        ).buildSpawnArgs({
          podId: 'abc',
          task: 'task',
          model,
          workDir: '/workspace',
          containerId: 'c1',
          env: {},
        });

      // Short aliases → full model IDs
      expect(buildArgs('sonnet')).toContain('claude-sonnet-5-5');
      expect(buildArgs('opus')).toContain('claude-opus-5-5');
      expect(buildArgs('haiku')).toContain('claude-haiku-4-5');

      // Full model IDs pass through unchanged
      expect(buildArgs('claude-fable-5')).toContain('claude-fable-5');
      expect(buildArgs('claude-opus-5')).toContain('claude-opus-5');
      expect(buildArgs('claude-sonnet-5')).toContain('claude-sonnet-5');
      expect(buildArgs('claude-sonnet-4-5')).toContain('claude-sonnet-4-5');
      expect(buildArgs('claude-opus-4-7')).toContain('claude-opus-4-7');
    });

    it('includes --session-id flag', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        podId: 'abc',
        task: 'task',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
      });

      expect(args).toContain('--session-id');
    });

    it('includes --debug when AUTOPOD_DEBUG_AGENT=1', () => {
      process.env.AUTOPOD_DEBUG_AGENT = '1';
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        podId: 'abc',
        task: 'task',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
      });

      expect(args).toContain('--debug');
    });

    it('does not include --debug by default', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        podId: 'abc',
        task: 'task',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
      });

      expect(args).not.toContain('--debug');
    });

    it('includes --mcp-config with file path when mcpServers is provided', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        podId: 'abc',
        task: 'task',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
        mcpServers: [{ name: 'escalation', url: 'http://localhost:3100/mcp' }],
      });

      expect(args).toContain('--mcp-config');
      const configIdx = args.indexOf('--mcp-config');
      expect(args[configIdx + 1]).toBe('/home/autopod/.autopod/mcp-config.json');
    });

    it('does not include --mcp-config when mcpServers is empty', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildSpawnArgs: (config: SpawnConfig) => string[] }
      ).buildSpawnArgs({
        podId: 'abc',
        task: 'task',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
        mcpServers: [],
      });

      expect(args).not.toContain('--mcp-config');
    });
  });

  // ---------------------------------------------------------------------------
  // writeMcpConfig
  // ---------------------------------------------------------------------------

  describe('writeMcpConfig', () => {
    it('writes MCP config JSON to the container', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      await (
        runtime as unknown as {
          writeMcpConfig: (
            containerId: string,
            mcpServers: SpawnConfig['mcpServers'],
          ) => Promise<void>;
        }
      ).writeMcpConfig('c1', [
        {
          name: 'escalation',
          url: 'http://host.docker.internal:3100/mcp/abc',
          headers: { Authorization: 'Bearer tok123' },
        },
      ]);

      expect(cm.writeFile).toHaveBeenCalledWith(
        'c1',
        '/home/autopod/.autopod/mcp-config.json',
        expect.any(String),
      );

      const written = (cm.writeFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
      const parsed = JSON.parse(written);
      expect(parsed.mcpServers.escalation).toMatchObject({
        type: 'http',
        url: 'http://host.docker.internal:3100/mcp/abc',
        headers: { Authorization: 'Bearer tok123' },
      });
    });

    it('emits stdio entries with command/args/env (not http url)', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      await (
        runtime as unknown as {
          writeMcpConfig: (
            containerId: string,
            mcpServers: SpawnConfig['mcpServers'],
          ) => Promise<void>;
        }
      ).writeMcpConfig('c1', [
        {
          type: 'stdio',
          name: 'serena',
          command: 'serena',
          args: ['--project', '/workspace'],
        },
        {
          type: 'stdio',
          name: 'roslyn-codelens',
          command: 'roslyn-codelens-mcp',
          env: { LOG_LEVEL: 'info' },
        },
      ]);

      const written = (cm.writeFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
      const parsed = JSON.parse(written);
      expect(parsed.mcpServers.serena).toEqual({
        type: 'stdio',
        command: 'serena',
        args: ['--project', '/workspace'],
      });
      expect(parsed.mcpServers['roslyn-codelens']).toEqual({
        type: 'stdio',
        command: 'roslyn-codelens-mcp',
        env: { LOG_LEVEL: 'info' },
      });
      expect(parsed.mcpServers.serena.url).toBeUndefined();
    });

    it('mixes http and stdio entries in the same config file', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      await (
        runtime as unknown as {
          writeMcpConfig: (
            containerId: string,
            mcpServers: SpawnConfig['mcpServers'],
          ) => Promise<void>;
        }
      ).writeMcpConfig('c1', [
        { type: 'http', name: 'escalation', url: 'http://host/mcp/abc' },
        { type: 'stdio', name: 'serena', command: 'serena', args: ['--project', '/workspace'] },
      ]);

      const written = (cm.writeFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[2];
      const parsed = JSON.parse(written);
      expect(parsed.mcpServers.escalation.type).toBe('http');
      expect(parsed.mcpServers.serena.type).toBe('stdio');
    });

    it('skips writing when mcpServers is empty', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      await (
        runtime as unknown as {
          writeMcpConfig: (config: SpawnConfig) => Promise<void>;
        }
      ).writeMcpConfig({
        podId: 'abc',
        task: 'task',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
        mcpServers: [],
      });

      expect(cm.writeFile).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // buildResumeArgs
  // ---------------------------------------------------------------------------

  describe('buildResumeArgs', () => {
    it('includes --resume flag when claudeSessionId is provided', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildResumeArgs: (msg: string, id?: string) => string[] }
      ).buildResumeArgs('Continue please', 'claude-pod-xyz');

      expect(args).toContain('--resume');
      expect(args).toContain('claude-pod-xyz');
      expect(args).toContain('--append-system-prompt-file');
      expect(args).toContain('/home/autopod/.autopod/system-instructions.md');
    });

    it('omits --resume when claudeSessionId is undefined', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      const args = (
        runtime as unknown as { buildResumeArgs: (msg: string, id?: string) => string[] }
      ).buildResumeArgs('Continue please', undefined);

      expect(args).not.toContain('--resume');
    });
  });

  // ---------------------------------------------------------------------------
  // spawn
  // ---------------------------------------------------------------------------

  describe('spawn', () => {
    it('calls execStreaming and yields parsed events from stdout', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        emitLine(handle.stdout as PassThrough, {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it...' }] },
        });
        emitLine(handle.stdout as PassThrough, {
          type: 'result',
          subtype: 'success',
          result: 'Done',
        });
        handle.finish(0);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        podId: 'sess-1',
        task: 'Do the thing',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'container-123',
        expect.arrayContaining(['claude', '-p', 'Do the thing']),
        expect.objectContaining({ cwd: '/workspace' }),
      );
      expect(events.length).toBeGreaterThan(0);
    });

    it('yields a fatal error event on non-zero exit code', async () => {
      const handle = createMockHandle({ exitCode: 1 });
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        handle.finish(1);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        podId: 'sess-fail',
        task: 'Fail',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent as unknown as AgentErrorEvent).message).toContain('exited with code 1');
      expect((errorEvent as unknown as AgentErrorEvent).fatal).toBe(true);
    });

    it('does not yield an error event on exit code 0', async () => {
      const handle = createMockHandle({ exitCode: 0 });
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        podId: 'sess-ok',
        task: 'Success',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      const fatalError = events.find(
        (e) => e.type === 'error' && (e as unknown as AgentErrorEvent).fatal === true,
      );
      expect(fatalError).toBeUndefined();
    });

    it('flushes stderr events interleaved with stdout events', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        // Write stderr first
        (handle.stderr as PassThrough).write('something went to stderr\n');
        // Then write a stdout event which will flush the buffered stderr event
        emitLine(handle.stdout as PassThrough, {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
        });
        handle.finish(0);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        podId: 'sess-stderr',
        task: 'Task',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      const stderrEvent = events.find(
        (e) => e.type === 'error' && (e as unknown as AgentErrorEvent).message.includes('[stderr]'),
      );
      expect(stderrEvent).toBeDefined();
    });

    it('extracts and stores Claude CLI session_id from init event for --resume', async () => {
      // Regression test for the sessions→pods rename bug: the fixture must
      // mirror Claude CLI's actual wire format (`session_id`), not autopod's
      // internal naming. If a future refactor renames this field back to
      // `pod_id`, capture breaks silently and every sleep recovery falls
      // back to a fresh spawn — burning tokens replaying work that was
      // already done.
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        emitLine(handle.stdout as PassThrough, {
          type: 'system',
          subtype: 'init',
          session_id: 'claude-sess-abc123',
        });
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.spawn({
        podId: 'sess-id-track',
        task: 'Task',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        /* consume */
      }

      expect(runtime.getClaudeSessionId('sess-id-track')).toBe('claude-sess-abc123');
    });

    it('removes handle tracking after completion', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.spawn({
        podId: 'track-sess',
        task: 'Task',
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        /* consume */
      }

      expect(
        (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.has(
          'track-sess',
        ),
      ).toBe(false);
    });

    it('redacts large task in spawn log but passes full task to execStreaming', async () => {
      const bigStr = 'X'.repeat(50_000);
      const infoSpy = vi.spyOn(logger, 'info');

      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.spawn({
        podId: 'redact-spawn',
        task: bigStr,
        model: 'opus',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        /* consume */
      }

      const spawnCall = infoSpy.mock.calls.find(
        (c) =>
          typeof c[0] === 'object' &&
          c[0] !== null &&
          (c[0] as Record<string, unknown>).msg === 'Spawning claude in container',
      );
      expect(spawnCall).toBeDefined();
      const logObj = spawnCall?.[0] as Record<string, unknown>;
      const loggedArgs = logObj.args as string[];
      expect(loggedArgs.at(-1)).toMatch(/^<task: 50000 bytes>$/);
      expect(JSON.stringify(logObj).includes(bigStr)).toBe(false);

      // Real args passed to execStreaming must still contain the full task
      const execArgs = (cm.execStreaming as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as string[];
      expect(execArgs.at(-1)).toBe(bigStr);
    });

    describe('CLI that outlives its final result (broad-earthworm regression)', () => {
      // The agent ended its turn with a background `npx vitest run` still
      // running (Bash run_in_background). Claude emitted its result but did
      // not exit, so stdout never closed and no exit was observed.
      async function runWedged(
        kind: 'spawn' | 'resume',
        kill: (handle: ReturnType<typeof createMockHandle>) => Promise<void>,
      ) {
        vi.stubEnv('AUTOPOD_POST_COMPLETE_GRACE_MS', '50');
        vi.stubEnv('AUTOPOD_EXIT_CODE_TIMEOUT_MS', '50');
        vi.stubEnv('AUTOPOD_RUNTIME_TERMINATION_TIMEOUT_MS', '200');
        const handle = createMockHandle();
        handle.kill = vi.fn(() => kill(handle));
        const cm = createMockContainerManager(handle);
        const runtime = new ClaudeRuntime(logger, cm);
        runtime.setClaudeSessionId('wedged-sess', 'native-session');
        setTimeout(() => {
          emitLine(handle.stdout as PassThrough, {
            type: 'result',
            subtype: 'success',
            result: 'Done',
          });
          // Deliberately do NOT close stdout or resolve the exit code.
        }, 10);
        const events: RuntimeEvent[] = [];
        const start = Date.now();
        const source =
          kind === 'resume'
            ? runtime.resume('wedged-sess', 'Fix validation', 'container-123')
            : runtime.spawn({
                podId: 'wedged-sess',
                task: 'Task',
                model: 'opus',
                reasoningEffort: 'auto',
                workDir: '/workspace',
                containerId: 'container-123',
                env: {},
              });
        const consumed = (async () => {
          for await (const event of source) events.push(event);
        })();
        return { handle, events, consumed, start };
      }
      afterEach(() => vi.unstubAllEnvs());

      it.each([
        'spawn',
        'resume',
      ] as const)('%s terminates the process tree, observes the exit and retains completion', async (kind) => {
        const { handle, events, consumed, start } = await runWedged(kind, async (h) => {
          (h.stdout as PassThrough).destroy();
          (h.stderr as PassThrough).destroy();
          h.finish(143);
        });
        await expect(consumed).resolves.toBeUndefined();
        expect(Date.now() - start).toBeLessThan(1_000);
        expect(handle.kill).toHaveBeenCalledOnce();
        // Grace still ends the daemon-side stream first.
        expect((handle.stdout as PassThrough).writableEnded).toBe(true);
        expect(events.some((e) => e.type === 'complete')).toBe(true);
        const errors = events.filter((e): e is AgentErrorEvent => e.type === 'error');
        expect(errors.some((e) => e.fatal)).toBe(false);
        expect(errors.map((e) => e.message).join('\n')).toContain(
          'terminated its process tree and observed exit code 143',
        );
      });

      it.each([
        'spawn',
        'resume',
      ] as const)('%s stays unverified when the tree termination is not verified', async (kind) => {
        const { handle, consumed } = await runWedged(kind, async () => {
          throw new Error('Remote streaming exec termination was not verified (exit 1)');
        });
        await expect(consumed).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
        expect(handle.kill).toHaveBeenCalledOnce();
      });

      it('stays unverified when the exit is still not observed after a verified kill', async () => {
        const { handle, consumed } = await runWedged('spawn', async () => {});
        await expect(consumed).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
        expect(handle.kill).toHaveBeenCalledOnce();
      });

      it('terminates and observes the exit when the consumer stops reading mid-turn', async () => {
        vi.stubEnv('AUTOPOD_EXIT_CODE_TIMEOUT_MS', '50');
        vi.stubEnv('AUTOPOD_RUNTIME_TERMINATION_TIMEOUT_MS', '200');
        const handle = createMockHandle();
        const cm = createMockContainerManager(handle);
        const runtime = new ClaudeRuntime(logger, cm);
        const iterator = runtime
          .spawn({
            podId: 'abandoned',
            task: 'Task',
            model: 'opus',
            reasoningEffort: 'auto',
            workDir: '/workspace',
            containerId: 'container-123',
            env: {},
          })
          [Symbol.asyncIterator]();
        const next = iterator.next();
        emitLine(handle.stdout as PassThrough, {
          type: 'system',
          subtype: 'init',
          session_id: 'native',
        });
        await next;
        // The consumer stops reading mid-turn: the process must still be
        // terminated and its exit observed before the generator settles.
        await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
        expect(handle.kill).toHaveBeenCalledOnce();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Turn finality (#648)
  // ---------------------------------------------------------------------------

  describe('turn finality (#648)', () => {
    const SESSION = 'native-session';
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const init = () => ({ type: 'system', subtype: 'init', session_id: SESSION });
    const result = (text: string, input = 10, output = 5, cost = 0.01) => ({
      type: 'result',
      subtype: 'success',
      result: text,
      total_cost_usd: cost,
      usage: { input_tokens: input, output_tokens: output },
    });
    const toolUse = (name: string, input: Record<string, unknown> = {}) => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: `tu-${name}`, name, input }] },
    });
    const toolResult = (name: string) => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: `tu-${name}`, content: 'ok' }] },
    });
    const backgroundStarted = (id = 'bg-1', extra: Record<string, unknown> = {}) => ({
      type: 'system',
      subtype: 'task_started',
      task_id: id,
      description: 'broad test suite',
      task_type: 'local_bash',
      is_backgrounded: true,
      ...extra,
    });
    const backgroundDone = (id = 'bg-1') => ({
      type: 'system',
      subtype: 'task_notification',
      task_id: id,
      status: 'completed',
      output_file: '/tmp/out',
      summary: 'done',
    });

    function start(
      kind: 'spawn' | 'resume',
      options: { backgroundWaitMs?: number; awaitBackgroundTasks?: () => boolean } = {},
    ) {
      vi.stubEnv('AUTOPOD_POST_COMPLETE_GRACE_MS', '60');
      vi.stubEnv('AUTOPOD_EXIT_CODE_TIMEOUT_MS', '50');
      vi.stubEnv('AUTOPOD_RUNTIME_TERMINATION_TIMEOUT_MS', '200');
      vi.stubEnv('AUTOPOD_CLAUDE_BACKGROUND_WAIT_MS', String(options.backgroundWaitMs ?? 60_000));
      const handle = createMockHandle();
      handle.kill = vi.fn(async () => {
        (handle.stdout as PassThrough).destroy();
        (handle.stderr as PassThrough).destroy();
        handle.finish(143);
      });
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm, {
        ...(options.awaitBackgroundTasks && { awaitBackgroundTasks: options.awaitBackgroundTasks }),
      });
      runtime.setClaudeSessionId('turn-pod', SESSION);
      const source =
        kind === 'resume'
          ? runtime.resume('turn-pod', 'Plan approved', 'container-123')
          : runtime.spawn({
              podId: 'turn-pod',
              task: 'Task',
              model: 'opus',
              reasoningEffort: 'auto',
              workDir: '/workspace',
              containerId: 'container-123',
              env: {},
            });
      const events: RuntimeEvent[] = [];
      const consumed = (async () => {
        for await (const event of source) events.push(event);
      })();
      const emit = (...frames: unknown[]) => {
        for (const frame of frames) emitLine(handle.stdout as PassThrough, frame);
      };
      return { handle, events, consumed, emit };
    }
    const completes = (events: RuntimeEvent[]) => events.filter((e) => e.type === 'complete');
    const usage = (events: RuntimeEvent[]) =>
      events.filter((e) => e.type === 'claude_result_usage');
    const errors = (events: RuntimeEvent[]) =>
      events.filter((e): e is AgentErrorEvent => e.type === 'error');

    afterEach(() => vi.unstubAllEnvs());

    it.each([
      'resume',
      'spawn',
    ] as const)('%s: an empty result followed by more tool events is not final and the agent is not killed', async (kind) => {
      const { handle, events, consumed, emit } = start(kind);
      emit(init(), result('', 3, 1, 0.001));
      // The same session starts its real turn within the grace window, then keeps
      // working for several grace windows: the old one-shot timer (armed by the
      // first result) force-closed the stream and killed the agent mid-edit.
      await sleep(20);
      emit(init(), toolUse('mcp__escalation__check_messages'));
      for (let i = 0; i < 5; i++) {
        await sleep(40);
        emit(
          toolResult('mcp__escalation__check_messages'),
          toolUse('Edit', { file_path: `/workspace/${i}.ts` }),
        );
      }
      emit(
        toolUse('mcp__escalation__report_task_summary'),
        toolResult('mcp__escalation__report_task_summary'),
        result('Phase 1 implemented', 20, 7, 0.02),
      );
      handle.finish(0);
      await consumed;

      expect(handle.kill).not.toHaveBeenCalled();
      // The daemon never force-closed the stream; Claude ended it itself.
      expect((handle.stdout as PassThrough).writableEnded).toBe(false);
      const done = completes(events);
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ result: 'Phase 1 implemented' });
      expect(usage(events)).toMatchObject([
        {
          cumulativeCostUsd: 0.001,
          totalInputTokens: 3,
          totalOutputTokens: 1,
          freshSession: kind === 'spawn',
          sessionId: SESSION,
        },
        { cumulativeCostUsd: 0.02, totalInputTokens: 20, totalOutputTokens: 7 },
      ]);
      expect(errors(events)).toEqual([]);
      expect(
        events.some(
          (e) => e.type === 'status' && e.message.includes('after an intermediate result'),
        ),
      ).toBe(true);
      // The complete is the last event: nothing of the continued turn was lost.
      expect(events.at(-1)?.type).toBe('complete');
      expect(events.filter((e) => e.type === 'file_change')).toHaveLength(5);
    });

    it('waits for background work and lets Claude continue on its notification', async () => {
      const { handle, events, consumed, emit } = start('spawn');
      emit(init(), backgroundStarted(), toolUse('Monitor'), result('Waiting on the broad suite.'));
      await sleep(200);
      expect(handle.kill).not.toHaveBeenCalled();
      expect(completes(events)).toEqual([]);
      emit(
        backgroundDone(),
        init(),
        toolUse('Bash', { command: 'git diff' }),
        toolResult('Bash'),
        toolUse('mcp__escalation__report_task_summary'),
        toolResult('mcp__escalation__report_task_summary'),
        result('Suite passed; summary reported.'),
      );
      handle.finish(0);
      await consumed;
      expect(handle.kill).not.toHaveBeenCalled();
      expect(completes(events).map((e) => e.result)).toEqual(['Suite passed; summary reported.']);
      expect(errors(events)).toEqual([]);
    });

    it('reports an interrupted turn when the bounded background wait expires', async () => {
      const { handle, events, consumed, emit } = start('resume', { backgroundWaitMs: 200 });
      emit(init(), backgroundStarted(), result('Waiting on the broad suite.'));
      await consumed;
      expect(handle.kill).toHaveBeenCalledOnce();
      // The usage is retained for accounting, without completing the turn.
      expect(usage(events)).toHaveLength(1);
      expect(completes(events)).toEqual([]);
      const fatal = errors(events).filter((e) => e.fatal);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]).toMatchObject({ turnInterrupted: true });
      expect(fatal[0]?.message).toContain('1 background task was still running');
      expect(fatal[0]?.message).toContain('exit code 143');
      expect(fatal[0]?.message).toContain('was not validated');
      expect(fatal[0]?.message).toContain('ap rework turn-pod');
      expect(events.at(-1)).toBe(fatal[0]);
      expect(errors(events).some((e) => e.message.includes('Completed turn retained'))).toBe(false);
    });

    it('reports an interrupted turn when background work finished but Claude never continued', async () => {
      const { handle, events, consumed, emit } = start('spawn');
      emit(init(), backgroundStarted(), result('Waiting.'));
      await sleep(30);
      emit(backgroundDone());
      await consumed;
      expect(handle.kill).toHaveBeenCalledOnce();
      const fatal = errors(events).filter((e) => e.fatal);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]?.turnInterrupted).toBe(true);
      expect(fatal[0]?.message).toContain('the work finished but Claude did not continue');
    });

    it('treats a clean exit right after a background-pending, unreported result as interrupted', async () => {
      const { handle, events, consumed, emit } = start('spawn');
      emit(init(), backgroundStarted(), result('Waiting.'));
      handle.finish(0);
      await consumed;
      expect(handle.kill).not.toHaveBeenCalled();
      const fatal = errors(events).filter((e) => e.fatal);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]).toMatchObject({ turnInterrupted: true });
      expect(fatal[0]?.message).toContain('the process exited (code 0) before it continued');
    });

    it('reports a kill after an intermediate result and further activity as interrupted', async () => {
      const { handle, events, consumed, emit } = start('resume');
      emit(init(), result(''), init(), toolUse('Edit', { file_path: '/workspace/a.ts' }));
      await sleep(20);
      // stdout closes but the process does not exit: the daemon must terminate it.
      (handle.stdout as PassThrough).push(null);
      await consumed;
      expect(handle.kill).toHaveBeenCalledOnce();
      expect(completes(events)).toEqual([]);
      const fatal = errors(events).filter((e) => e.fatal);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]).toMatchObject({ turnInterrupted: true });
      expect(fatal[0]?.message).toContain('while still working after an intermediate result');
      expect(usage(events)).toMatchObject([{ cumulativeCostUsd: 0.01, totalInputTokens: 10 }]);
    });

    it.each([
      [
        'a reported summary',
        { awaitBackgroundTasks: undefined },
        [toolUse('mcp__escalation__report_task_summary')],
      ],
      ['a pending human decision', { awaitBackgroundTasks: () => false }, []],
      [
        'a throwing pod lookup',
        {
          awaitBackgroundTasks: () => {
            throw new Error('gone');
          },
        },
        [],
      ],
    ] as const)('keeps the retained-completion grace after %s', async (_label, options, extra) => {
      const { handle, events, consumed, emit } = start('spawn', {
        ...(options.awaitBackgroundTasks && { awaitBackgroundTasks: options.awaitBackgroundTasks }),
      });
      emit(init(), backgroundStarted('dev-server'), ...extra, result('Done.'));
      await consumed;
      expect(handle.kill).toHaveBeenCalledOnce();
      expect(completes(events).map((e) => e.result)).toEqual(['Done.']);
      expect(errors(events).some((e) => e.fatal)).toBe(false);
      expect(
        errors(events)
          .map((e) => e.message)
          .join('\n'),
      ).toContain('Completed turn retained');
    });

    it('does not wait for ambient housekeeping tasks', async () => {
      const { handle, events, consumed, emit } = start('spawn');
      emit(init(), backgroundStarted('watch', { ambient: true }), result('Done.'));
      const started = Date.now();
      await consumed;
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(handle.kill).toHaveBeenCalledOnce();
      expect(errors(events).some((e) => e.fatal)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // resume
  // ---------------------------------------------------------------------------

  describe('reasoning effort', () => {
    const efforts = ['low', 'medium', 'high', 'xhigh'] as const;

    it.each(efforts)('passes %s exactly on spawn and continuation', (reasoningEffort) => {
      const runtime = new ClaudeRuntime(logger, createMockContainerManager(createMockHandle()));
      const privateRuntime = runtime as unknown as {
        buildSpawnArgs: (config: SpawnConfig) => string[];
        buildResumeArgs: (
          message: string,
          sessionId: string,
          mcpServers: SpawnConfig['mcpServers'],
          effort: SpawnConfig['reasoningEffort'],
        ) => string[];
      };
      const config: SpawnConfig = {
        podId: 'effort-pod',
        task: 'work',
        model: 'claude-opus-5',
        reasoningEffort,
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
      };

      expect(privateRuntime.buildSpawnArgs(config)).toEqual(
        expect.arrayContaining(['--effort', reasoningEffort]),
      );
      expect(privateRuntime.buildResumeArgs('continue', 'session-1', [], reasoningEffort)).toEqual(
        expect.arrayContaining(['--effort', reasoningEffort]),
      );
    });

    it('omits the native control for auto on spawn and continuation', () => {
      const runtime = new ClaudeRuntime(logger, createMockContainerManager(createMockHandle()));
      const privateRuntime = runtime as unknown as {
        buildSpawnArgs: (config: SpawnConfig) => string[];
        buildResumeArgs: (
          message: string,
          sessionId: string,
          mcpServers: SpawnConfig['mcpServers'],
          effort: SpawnConfig['reasoningEffort'],
        ) => string[];
      };
      const config: SpawnConfig = {
        podId: 'effort-pod',
        task: 'work',
        model: 'claude-opus-5',
        reasoningEffort: 'auto',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
      };

      expect(privateRuntime.buildSpawnArgs(config)).not.toContain('--effort');
      expect(privateRuntime.buildResumeArgs('continue', 'session-1', [], 'auto')).not.toContain(
        '--effort',
      );
    });

    it('retains the configured effort through the public spawn and resume path', async () => {
      const first = createMockHandle();
      const second = createMockHandle();
      const cm = createMockContainerManager(first);
      vi.mocked(cm.execStreaming).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      const runtime = new ClaudeRuntime(logger, cm);

      const spawnDone = (async () => {
        for await (const _ of runtime.spawn({
          podId: 'effort-pod',
          task: 'work',
          model: 'claude-opus-5',
          reasoningEffort: 'high',
          workDir: '/workspace',
          containerId: 'c1',
          env: {},
        })) {
          // drain
        }
      })();
      first.finish(0);
      await spawnDone;

      const resumeDone = (async () => {
        for await (const _ of runtime.resume('effort-pod', 'continue', 'c2')) {
          // drain
        }
      })();
      second.finish(0);
      await resumeDone;

      expect(cm.execStreaming).toHaveBeenLastCalledWith(
        'c2',
        expect.arrayContaining(['--effort', 'high']),
        expect.any(Object),
      );
    });

    it('rehydrates reasoning effort for durable recovery in a fresh runtime', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);
      runtime.setClaudeSessionId('recovered-pod', 'claude-session');
      runtime.setClaudeResumeConfig('recovered-pod', [], 'xhigh');

      const resumeDone = (async () => {
        for await (const _ of runtime.resume('recovered-pod', 'continue', 'c2')) {
          // drain
        }
      })();
      handle.finish(0);
      await resumeDone;

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'c2',
        expect.arrayContaining(['--effort', 'xhigh', '--resume', 'claude-session']),
        expect.any(Object),
      );
    });
  });

  describe('resume', () => {
    it('resume log has no args field (defensive snapshot)', async () => {
      const infoSpy = vi.spyOn(logger, 'info');

      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      runtime.setClaudeSessionId('resume-snapshot', 'sess-xyz');

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.resume(
        'resume-snapshot',
        'Do something',
        'container-123',
        {},
      )) {
        /* consume */
      }

      const resumeLog = infoSpy.mock.calls.find(
        (c) =>
          typeof c[0] === 'object' &&
          c[0] !== null &&
          (c[0] as Record<string, unknown>).msg === 'Resuming claude pod in container',
      );
      expect(resumeLog).toBeDefined();
      expect(resumeLog?.[0] as Record<string, unknown>).not.toHaveProperty('args');
    });

    it('calls execStreaming with --resume when a claude pod ID is known', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      // Pre-set a Claude pod ID
      runtime.setClaudeSessionId('sess-1', 'claude-internal-xyz');

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.resume('sess-1', 'Fix the issue', 'container-123', {})) {
        /* consume */
      }

      const calledArgs = (cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      expect(calledArgs).toContain('--resume');
      expect(calledArgs).toContain('claude-internal-xyz');
    });

    it('calls execStreaming without --resume when no claude pod ID is known', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.resume('sess-new', 'Continue please', 'container-123')) {
        /* consume */
      }

      const calledArgs = (cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      expect(calledArgs).not.toContain('--resume');
    });

    it('removes handle tracking after resume completion', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      setTimeout(() => {
        handle.finish(0);
      }, 10);

      for await (const _ of runtime.resume('track-resume', 'msg', 'c1')) {
        /* consume */
      }

      expect(
        (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.has(
          'track-resume',
        ),
      ).toBe(false);
    });

    it.each([
      false,
      true,
    ])('falls back on a missing session (error result: %s)', async (errorResult) => {
      // Regression: a fresh container has no `~/.claude/projects/<id>.jsonl`,
      // so `--resume <id>` prints "No conversation found with session ID: …"
      // to stderr and exits. Without this throw, pod-manager's fallback to a
      // fresh spawn never engages and the agent dies silently with no work done.
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      runtime.setClaudeSessionId('sess-missing', 'stale-session-uuid');

      setTimeout(() => {
        const message = 'No conversation found with session ID: stale-session-uuid';
        if (errorResult)
          emitLine(handle.stdout as PassThrough, {
            type: 'result',
            is_error: true,
            errors: [message],
            total_cost_usd: 0,
            session_id: 'stale-session-uuid',
          });
        handle.stderr.write(`${message}\n`);
        handle.finish(1);
      }, 10);

      let caught: unknown;
      const events: RuntimeEvent[] = [];
      try {
        for await (const event of runtime.resume('sess-missing', 'msg', 'c1')) events.push(event);
      } catch (err) {
        caught = err;
      }

      expect(
        events.some((e) => e.type === 'claude_result_usage' || (e.type === 'error' && e.fatal)),
      ).toBe(false);
      expect(caught).toBeInstanceOf(ResumeSessionNotFoundError);
      expect((caught as ResumeSessionNotFoundError).claudeSessionId).toBe('stale-session-uuid');
      // The stale ID is dropped from the in-memory map so any retry doesn't reuse it.
      expect(
        (runtime as unknown as { claudeSessionIds: Map<string, string> }).claudeSessionIds.has(
          'sess-missing',
        ),
      ).toBe(false);
    });

    it('does NOT throw when stderr contains unrelated warnings', async () => {
      // Make sure we don't false-positive on benign stderr output.
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      runtime.setClaudeSessionId('sess-ok', 'good-session-uuid');

      setTimeout(() => {
        handle.stderr.write('Warning: something noisy but harmless\n');
        handle.finish(0);
      }, 10);

      let caught: unknown;
      try {
        for await (const _ of runtime.resume('sess-ok', 'msg', 'c1')) {
          /* consume */
        }
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // abort
  // ---------------------------------------------------------------------------

  describe('abort', () => {
    it('calls handle.kill() and cleans up both pod and claude pod IDs', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.set(
        'sess-1',
        handle,
      );
      runtime.setClaudeSessionId('sess-1', 'claude-xyz');

      await runtime.abort('sess-1');

      expect(handle.kill).toHaveBeenCalled();
      expect(
        (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.has('sess-1'),
      ).toBe(false);
      expect(runtime.getClaudeSessionId('sess-1')).toBeUndefined();
    });

    it('is a no-op when no handle is tracked', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      await expect(runtime.abort('nonexistent')).resolves.toBeUndefined();
      expect(handle.kill).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // suspend
  // ---------------------------------------------------------------------------

  describe('suspend', () => {
    it('kills the handle but preserves the claude pod ID for resume', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.set(
        'sess-1',
        handle,
      );
      runtime.setClaudeSessionId('sess-1', 'claude-preserve-me');

      await runtime.suspend('sess-1');

      expect(handle.kill).toHaveBeenCalled();
      expect(
        (runtime as unknown as { handles: Map<string, StreamingExecResult> }).handles.has('sess-1'),
      ).toBe(false);
      // Pod ID preserved (unlike abort)
      expect(runtime.getClaudeSessionId('sess-1')).toBe('claude-preserve-me');
    });

    it('is a no-op when no handle is tracked', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      await expect(runtime.suspend('nonexistent')).resolves.toBeUndefined();
      expect(handle.kill).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // setClaudeSessionId / getClaudeSessionId
  // ---------------------------------------------------------------------------

  describe('setClaudeSessionId / getClaudeSessionId', () => {
    it('stores and retrieves a claude pod ID', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      runtime.setClaudeSessionId('my-pod', 'claude-abc');
      expect(runtime.getClaudeSessionId('my-pod')).toBe('claude-abc');
    });

    it('returns undefined for unknown pods', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new ClaudeRuntime(logger, cm);

      expect(runtime.getClaudeSessionId('unknown')).toBeUndefined();
    });
  });
});
