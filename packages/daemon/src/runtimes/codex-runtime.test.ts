import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AgentErrorEvent, AgentEvent, AgentStatusEvent, SpawnConfig } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import type { PodRepository } from '../pods/pod-repository.js';
import { CodexRuntime } from './codex-runtime.js';

const logger = pino({ level: 'silent' });

function createMockHandle(options?: { exitCode?: number }): StreamingExecResult {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExitCode: (code: number) => void;
  const exitCodePromise = new Promise<number>((resolve) => {
    resolveExitCode = resolve;
  });

  const handle: StreamingExecResult = {
    stdout,
    stderr,
    exitCode: exitCodePromise,
    kill: vi.fn(async () => {
      stdout.destroy();
      stderr.destroy();
      resolveExitCode?.(options?.exitCode ?? 137);
    }),
  };

  // Helper to finish the stream: push null on stdout and resolve exitCode
  (handle as unknown as { finish: (code?: number) => void }).finish = (code?: number) => {
    stdout.push(null);
    resolveExitCode?.(code ?? options?.exitCode ?? 0);
  };

  return handle;
}

function createMockContainerManager(handle: StreamingExecResult): ContainerManager {
  return {
    spawn: vi.fn(async () => 'container-123'),
    kill: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    getStatus: vi.fn(async () => 'running' as const),
    execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    execStreaming: vi.fn(async () => handle),
  };
}

function createMockPodRepo(codexSessionId: string | null = null): PodRepository {
  return {
    insert: vi.fn(),
    getOrThrow: vi.fn(() => ({ codexSessionId }) as ReturnType<PodRepository['getOrThrow']>),
    update: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(() => []),
    listNonTerminal: vi.fn(() => []),
    countByStatusAndProfile: vi.fn(() => 0),
    getStats: vi.fn(() => ({
      total: 0,
      byStatus: {} as ReturnType<PodRepository['getStats']>['byStatus'],
    })),
    getPodsDependingOn: vi.fn(() => []),
    getPodsBySeries: vi.fn(() => []),
    listNonTerminalPodIds: vi.fn(() => []),
    listTerminalPodsCompletedBefore: vi.fn(() => []),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

describe('CodexRuntime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildSpawnArgs', () => {
    it('builds correct args from config', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      const args = (runtime as any).buildSpawnArgs({
        podId: 'abc123',
        task: 'Fix the bug',
        model: 'o3-mini',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      });
      expect(args).toEqual([
        'exec',
        '--model',
        'o3-mini',
        '--dangerously-bypass-approvals-and-sandbox',
        '--json',
        'Fix the bug',
      ]);
    });

    it('omits --model for the auto sentinel so Codex chooses the account default', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      const args = (runtime as any).buildSpawnArgs({
        podId: 'abc123',
        task: 'Fix the bug',
        model: 'auto',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      });
      expect(args).toEqual([
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--json',
        'Fix the bug',
      ]);
    });

    it('prefixes the Codex prompt with Autopod custom instructions when provided', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      const args = (runtime as any).buildSpawnArgs({
        podId: 'abc123',
        task: 'Fix the bug',
        model: 'auto',
        workDir: '/workspace',
        containerId: 'container-123',
        customInstructions: '# Autopod Pod\n\nCall report_plan first.',
        env: {},
      });
      expect(args.at(-1)).toContain('# Autopod Pod');
      expect(args.at(-1)).toContain('## Current Codex Turn');
      expect(args.at(-1)).toContain('Fix the bug');
    });
  });

  describe('spawn', () => {
    it('calls execStreaming and yields events from stdout', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      setTimeout(() => {
        (handle.stdout as PassThrough).write(
          `${JSON.stringify({ id: '1', msg: { type: 'agent_message', message: 'Starting' } })}\n`,
        );
        (handle.stdout as PassThrough).write(
          `${JSON.stringify({ id: '2', msg: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Done' } })}\n`,
        );
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        podId: 'test-sess',
        task: 'Do the thing',
        model: 'o3-mini',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe('reasoning');
      expect(events[1]?.type).toBe('complete');

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'container-123',
        [
          'sh',
          '/run/autopod/agent-shim.sh',
          'codex',
          'exec',
          '--model',
          'o3-mini',
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
          'Do the thing',
        ],
        expect.objectContaining({ cwd: '/workspace' }),
      );
    });

    it('does not treat turn_complete as final task completion', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      setTimeout(() => {
        (handle.stdout as PassThrough).write(
          `${JSON.stringify({ id: '1', msg: { type: 'turn_complete', turn_id: 't1', last_agent_message: 'advisor answered' } })}\n`,
        );
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
      }, 10);

      const events: AgentEvent[] = [];
      for await (const event of runtime.spawn({
        podId: 'turn-only',
        task: 'Do the thing',
        model: 'o3-mini',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      expect(events.some((event) => event.type === 'complete')).toBe(false);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'status', message: 'Codex turn complete' }),
          expect.objectContaining({
            type: 'error',
            fatal: true,
            message: expect.stringContaining('without terminal completion'),
          }),
        ]),
      );
    });

    it('redacts large task in spawn log but passes full task to execStreaming', async () => {
      const bigStr = 'X'.repeat(50_000);
      const infoSpy = vi.spyOn(logger, 'info');

      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      setTimeout(() => {
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
      }, 10);

      for await (const _ of runtime.spawn({
        podId: 'redact-spawn',
        task: bigStr,
        model: 'o3-mini',
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
          (c[0] as Record<string, unknown>).msg === 'Spawning codex in container',
      );
      expect(spawnCall).toBeDefined();
      const logObj = spawnCall?.[0] as Record<string, unknown>;
      const loggedArgs = logObj.args as string[];
      expect(loggedArgs.at(-1)).toMatch(/^<task: 50000 bytes>$/);
      expect(JSON.stringify(logObj).includes(bigStr)).toBe(false);

      // Real args to execStreaming still contain the full task
      const execArgs = (cm.execStreaming as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as string[];
      expect(execArgs).toContain(bigStr);
    });

    it('yields error event on non-zero exit code', async () => {
      const handle = createMockHandle({ exitCode: 1 });
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      setTimeout(() => {
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(1);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        podId: 'test-sess',
        task: 'Fail',
        model: 'o3-mini',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: accessing runtime event fields in test
      expect((errorEvent as any).message).toContain('exited with code 1');
      // biome-ignore lint/suspicious/noExplicitAny: accessing runtime event fields in test
      expect((errorEvent as any).fatal).toBe(true);
    });

    it('maps exit code 127 to a missing Codex CLI error', async () => {
      const handle = createMockHandle({ exitCode: 127 });
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      setTimeout(() => {
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(127);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        podId: 'missing-codex',
        task: 'Fail',
        model: 'o3-mini',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      // biome-ignore lint/suspicious/noExplicitAny: accessing runtime event fields in test
      expect((errorEvent as any).message).toContain('Codex CLI not found');
      // biome-ignore lint/suspicious/noExplicitAny: accessing runtime event fields in test
      expect((errorEvent as any).fatal).toBe(true);
    });

    it('terminates within grace window when stdout never closes after task_complete', async () => {
      // Wedged-container parity with claude-runtime: emit the parser's
      // `complete` event then deliberately leave stdout open and exit code
      // unresolved. The grace timer should end stdout and the bounded
      // exit-code wait should fall through with a non-fatal error.
      process.env.AUTOPOD_POST_COMPLETE_GRACE_MS = '50';
      process.env.AUTOPOD_EXIT_CODE_TIMEOUT_MS = '50';

      try {
        const handle = createMockHandle();
        const cm = createMockContainerManager(handle);
        const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

        setTimeout(() => {
          (handle.stdout as PassThrough).write(
            `${JSON.stringify({
              id: '1',
              msg: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Done' },
            })}\n`,
          );
          // Deliberately do NOT close stdout or resolve exit code.
        }, 10);

        const events: AgentEvent[] = [];
        const start = Date.now();
        for await (const event of runtime.spawn({
          podId: 'wedged-codex',
          task: 'Task',
          model: 'o3-mini',
          workDir: '/workspace',
          containerId: 'container-123',
          env: {},
        })) {
          events.push(event);
        }
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(500);
        expect((handle.stdout as PassThrough).writableEnded).toBe(true);

        const completeEvent = events.find((e) => e.type === 'complete');
        expect(completeEvent).toBeDefined();

        const wedgeError = events.find(
          (e) =>
            e.type === 'error' &&
            (e as AgentErrorEvent).fatal === false &&
            (e as AgentErrorEvent).message.includes('Codex exit code did not resolve'),
        );
        expect(wedgeError).toBeDefined();
      } finally {
        // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies to "undefined"
        delete process.env.AUTOPOD_POST_COMPLETE_GRACE_MS;
        // biome-ignore lint/performance/noDelete: must actually unset, `= undefined` stringifies to "undefined"
        delete process.env.AUTOPOD_EXIT_CODE_TIMEOUT_MS;
      }
    });

    it('cleans up handle tracking after completion', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      setTimeout(() => {
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
      }, 10);

      for await (const _ of runtime.spawn({
        podId: 'track-test',
        task: 'test',
        model: 'o3-mini',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        /* consume */
      }

      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      expect((runtime as any).handles.has('track-test')).toBe(false);
    });

    it('populates codexSessionIds map from AgentStatusEvent.sessionId during spawn', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      setTimeout(() => {
        // Emit a session_configured status event with sessionId set
        (handle.stdout as PassThrough).write(
          `${JSON.stringify({
            id: '1',
            msg: { type: 'session_configured', session_id: 'sess-abc-123', model: 'gpt-4o' },
          })}\n`,
        );
        (handle.stdout as PassThrough).write(
          `${JSON.stringify({ id: '2', msg: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Done' } })}\n`,
        );
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
      }, 10);

      for await (const _ of runtime.spawn({
        podId: 'map-test',
        task: 'test',
        model: 'gpt-4o',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        /* consume */
      }

      expect(runtime.codexSessionIds.get('map-test')).toBe('sess-abc-123');
    });

    it('replays the latest rollout JSONL when stdout produces no Codex events', async () => {
      const previousStateDir = process.env.AUTOPOD_CODEX_STATE_DIR;
      const tmpRoot = await mkdtemp(join(tmpdir(), 'autopod-codex-runtime-'));
      process.env.AUTOPOD_CODEX_STATE_DIR = tmpRoot;

      try {
        const podId = 'rollout-fallback';
        const rolloutDir = join(tmpRoot, podId, '2026', '05', '25');
        await mkdir(rolloutDir, { recursive: true });
        await writeFile(
          join(rolloutDir, 'rollout-2026-05-25T20-44-42-019e60e1.jsonl'),
          [
            JSON.stringify({
              timestamp: '2026-05-25T20:44:42.000Z',
              type: 'session_meta',
              payload: { id: 'sess-rollout-123', cwd: '/workspace' },
            }),
            JSON.stringify({
              timestamp: '2026-05-25T20:44:43.000Z',
              type: 'event_msg',
              payload: { type: 'task_started', turn_id: 'turn-1' },
            }),
            JSON.stringify({
              timestamp: '2026-05-25T20:44:44.000Z',
              type: 'turn_context',
              payload: { model: 'gpt-5.5' },
            }),
            JSON.stringify({
              timestamp: '2026-05-25T20:44:45.000Z',
              type: 'response_item',
              payload: {
                type: 'function_call',
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'git status --short', workdir: '/workspace' }),
                call_id: 'call-1',
              },
            }),
            JSON.stringify({
              timestamp: '2026-05-25T20:44:46.000Z',
              type: 'response_item',
              payload: {
                type: 'function_call_output',
                call_id: 'call-1',
                output: 'clean',
              },
            }),
            JSON.stringify({
              timestamp: '2026-05-25T20:44:47.000Z',
              type: 'event_msg',
              payload: {
                type: 'token_count',
                info: {
                  total_token_usage: {
                    input_tokens: 123,
                    output_tokens: 45,
                  },
                },
              },
            }),
            JSON.stringify({
              timestamp: '2026-05-25T20:44:48.000Z',
              type: 'event_msg',
              payload: {
                type: 'task_complete',
                last_agent_message: 'Probe complete',
              },
            }),
          ].join('\n'),
        );

        const handle = createMockHandle();
        const cm = createMockContainerManager(handle);
        const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

        setTimeout(() => {
          // Finish with an empty stdout stream, matching the observed Docker/Codex path.
          // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
          (handle as any).finish(0);
        }, 10);

        const events: AgentEvent[] = [];
        for await (const event of runtime.spawn({
          podId,
          task: 'Probe event streaming',
          model: 'gpt-5.5',
          workDir: '/workspace',
          containerId: 'container-123',
          env: {},
        })) {
          events.push(event);
        }

        expect(runtime.codexSessionIds.get(podId)).toBe('sess-rollout-123');
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'status',
              message: 'Codex session ready',
              sessionId: 'sess-rollout-123',
            }),
            expect.objectContaining({
              type: 'tool_use',
              tool: 'Bash',
              input: expect.objectContaining({
                command: 'git status --short',
                cwd: '/workspace',
              }),
            }),
            expect.objectContaining({
              type: 'tool_use',
              output: 'clean',
            }),
            expect.objectContaining({
              type: 'complete',
              result: 'Probe complete',
              totalInputTokens: 123,
              totalOutputTokens: 45,
            }),
          ]),
        );
      } finally {
        if (previousStateDir === undefined) {
          // biome-ignore lint/performance/noDelete: tests must restore absent env vars exactly
          delete process.env.AUTOPOD_CODEX_STATE_DIR;
        } else {
          process.env.AUTOPOD_CODEX_STATE_DIR = previousStateDir;
        }
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

    it('emits one completion when stdout and rollout both finish', async () => {
      const previousStateDir = process.env.AUTOPOD_CODEX_STATE_DIR;
      const previousPollMs = process.env.AUTOPOD_CODEX_ROLLOUT_POLL_MS;
      const tmpRoot = await mkdtemp(join(tmpdir(), 'autopod-codex-runtime-dual-complete-'));
      process.env.AUTOPOD_CODEX_STATE_DIR = tmpRoot;
      process.env.AUTOPOD_CODEX_ROLLOUT_POLL_MS = '10';

      try {
        const podId = 'dual-complete';
        const rolloutDir = join(tmpRoot, podId, '2026', '07', '12');
        await mkdir(rolloutDir, { recursive: true });
        await writeFile(
          join(rolloutDir, 'rollout-2026-07-12T15-00-00-thread-123.jsonl'),
          [
            JSON.stringify({
              timestamp: '2026-07-12T15:00:00.000Z',
              type: 'event_msg',
              payload: {
                type: 'token_count',
                info: { total_token_usage: { input_tokens: 120, output_tokens: 30 } },
              },
            }),
            JSON.stringify({
              timestamp: '2026-07-12T15:00:01.000Z',
              type: 'event_msg',
              payload: { type: 'task_complete', last_agent_message: 'Finished from rollout.' },
            }),
          ].join('\n'),
        );

        const handle = createMockHandle();
        const cm = createMockContainerManager(handle);
        const runtime = new CodexRuntime(logger, cm, createMockPodRepo());
        const iterator = runtime
          .spawn({
            podId,
            task: 'Finish once',
            model: 'gpt-5.5',
            workDir: '/workspace',
            containerId: 'container-123',
            env: {},
          })
          [Symbol.asyncIterator]();

        const first = await withTimeout(iterator.next(), 1_000);
        expect(first.value).toMatchObject({ type: 'complete', result: 'Finished from rollout.' });

        (handle.stdout as PassThrough).write(
          `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' })}\n`,
        );
        (handle.stdout as PassThrough).write(
          `${JSON.stringify({
            type: 'item.completed',
            item: { id: 'item-1', type: 'agent_message', text: 'Finished from stdout.' },
          })}\n`,
        );
        (handle.stdout as PassThrough).write(
          `${JSON.stringify({
            type: 'turn.completed',
            usage: {
              input_tokens: 120,
              cached_input_tokens: 20,
              output_tokens: 30,
              reasoning_output_tokens: 5,
            },
          })}\n`,
        );
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);

        const events: AgentEvent[] = [first.value as AgentEvent];
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          events.push(next.value);
        }

        const completions = events.filter((event) => event.type === 'complete');
        expect(completions).toHaveLength(1);
        expect(completions[0]).toMatchObject({
          totalInputTokens: 120,
          totalOutputTokens: 30,
          costUsd: expect.any(Number),
        });
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'status', sessionId: 'thread-123' }),
            expect.objectContaining({ type: 'reasoning', text: 'Finished from stdout.' }),
          ]),
        );
      } finally {
        if (previousStateDir === undefined) {
          // biome-ignore lint/performance/noDelete: tests must restore absent env vars exactly
          delete process.env.AUTOPOD_CODEX_STATE_DIR;
        } else {
          process.env.AUTOPOD_CODEX_STATE_DIR = previousStateDir;
        }
        if (previousPollMs === undefined) {
          // biome-ignore lint/performance/noDelete: tests must restore absent env vars exactly
          delete process.env.AUTOPOD_CODEX_ROLLOUT_POLL_MS;
        } else {
          process.env.AUTOPOD_CODEX_ROLLOUT_POLL_MS = previousPollMs;
        }
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });

    it('yields rollout MCP tool events while stdout is still open', async () => {
      const previousStateDir = process.env.AUTOPOD_CODEX_STATE_DIR;
      const previousPollMs = process.env.AUTOPOD_CODEX_ROLLOUT_POLL_MS;
      const tmpRoot = await mkdtemp(join(tmpdir(), 'autopod-codex-runtime-live-'));
      process.env.AUTOPOD_CODEX_STATE_DIR = tmpRoot;
      process.env.AUTOPOD_CODEX_ROLLOUT_POLL_MS = '10';

      try {
        const podId = 'rollout-live';
        const rolloutDir = join(tmpRoot, podId, '2026', '05', '26');
        const rolloutPath = join(rolloutDir, 'rollout-2026-05-26T15-31-16-019e64e9.jsonl');
        await mkdir(rolloutDir, { recursive: true });

        const handle = createMockHandle();
        const cm = createMockContainerManager(handle);
        const runtime = new CodexRuntime(logger, cm, createMockPodRepo());
        const iterator = runtime
          .spawn({
            podId,
            task: 'Deploy',
            model: 'gpt-5.5',
            workDir: '/workspace',
            containerId: 'container-123',
            env: {},
          })
          [Symbol.asyncIterator]();

        const firstEvent = withTimeout(iterator.next(), 1_000);
        setTimeout(() => {
          void writeFile(
            rolloutPath,
            [
              JSON.stringify({
                timestamp: '2026-05-26T15:31:40.000Z',
                type: 'event_msg',
                payload: {
                  type: 'mcp_tool_call_end',
                  call_id: 'call-deploy',
                  invocation: {
                    server: 'escalation',
                    tool: 'run_deploy_script',
                    arguments: { script_path: 'infra/azure/acr-deploy.sh' },
                  },
                  result: { Ok: { content: [{ type: 'text', text: 'exit 0' }] } },
                },
              }),
              JSON.stringify({
                timestamp: '2026-05-26T15:31:41.000Z',
                type: 'event_msg',
                payload: {
                  type: 'task_complete',
                  last_agent_message: 'Deployment complete',
                },
              }),
            ].join('\n'),
          );
        }, 20);

        const first = await firstEvent;
        expect(first.done).toBe(false);
        expect(first.value).toMatchObject({
          type: 'tool_use',
          tool: 'mcp__escalation__run_deploy_script',
          input: expect.objectContaining({
            call_id: 'call-deploy',
            server: 'escalation',
            script_path: 'infra/azure/acr-deploy.sh',
          }),
          output: expect.stringContaining('exit 0'),
        });

        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
        const rest: AgentEvent[] = [];
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          rest.push(next.value);
        }

        expect(rest).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'complete',
              result: 'Deployment complete',
            }),
          ]),
        );
      } finally {
        if (previousStateDir === undefined) {
          // biome-ignore lint/performance/noDelete: tests must restore absent env vars exactly
          delete process.env.AUTOPOD_CODEX_STATE_DIR;
        } else {
          process.env.AUTOPOD_CODEX_STATE_DIR = previousStateDir;
        }
        if (previousPollMs === undefined) {
          // biome-ignore lint/performance/noDelete: tests must restore absent env vars exactly
          delete process.env.AUTOPOD_CODEX_ROLLOUT_POLL_MS;
        } else {
          process.env.AUTOPOD_CODEX_ROLLOUT_POLL_MS = previousPollMs;
        }
        await rm(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe('resume', () => {
    it('redacts large message in resume log args (no session ID — full-auto path)', async () => {
      const bigStr = 'X'.repeat(50_000);
      const infoSpy = vi.spyOn(logger, 'info');

      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo(null));

      setTimeout(() => {
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
      }, 10);

      for await (const _ of runtime.resume('sess-redact', bigStr, 'container-123')) {
        /* consume */
      }

      const resumeCall = infoSpy.mock.calls.find(
        (c) =>
          typeof c[0] === 'object' &&
          c[0] !== null &&
          (c[0] as Record<string, unknown>).msg ===
            'Resuming codex with follow-up message in container',
      );
      expect(resumeCall).toBeDefined();
      const logObj = resumeCall?.[0] as Record<string, unknown>;
      const loggedArgs = logObj.args as string[];
      expect(loggedArgs.at(-1)).toMatch(/^<task: 50000 bytes>$/);
      expect(JSON.stringify(logObj).includes(bigStr)).toBe(false);

      // Real args to execStreaming still contain the full message
      const execArgs = (cm.execStreaming as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as string[];
      expect(execArgs).toContain(bigStr);
    });

    it('calls execStreaming with message as task in full-auto mode when no session ID', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo(null));

      setTimeout(() => {
        (handle.stdout as PassThrough).write(
          `${JSON.stringify({ id: '1', msg: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Fixed' } })}\n`,
        );
        (handle.stdout as PassThrough).push(null);
        // Resolve exitCode after stdout ends
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
      }, 10);

      const events = [];
      for await (const event of runtime.resume(
        'sess-1',
        'Fix the validation errors',
        'container-123',
      )) {
        events.push(event);
      }

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'container-123',
        [
          'sh',
          '/run/autopod/agent-shim.sh',
          'codex',
          'exec',
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
          'Fix the validation errors',
        ],
        expect.any(Object),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('complete');
    });

    it('prefixes no-session resume prompts with stored Autopod instructions', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo(null));
      // biome-ignore lint/suspicious/noExplicitAny: accessing private map in test
      (runtime as any).customInstructionsBySession.set('sess-1', '# Autopod Pod');

      setTimeout(() => {
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
      }, 10);

      for await (const _ of runtime.resume(
        'sess-1',
        'Fix the validation errors',
        'container-123',
      )) {
        /* consume */
      }

      const execArgs = (cm.execStreaming as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as string[];
      expect(execArgs.at(-1)).toContain('# Autopod Pod');
      expect(execArgs.at(-1)).toContain('Fix the validation errors');
    });

    it('uses exec resume subcommand when pod has codexSessionId in DB', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const mockRepo = createMockPodRepo('session-from-db-xyz');
      const runtime = new CodexRuntime(logger, cm, mockRepo);

      setTimeout(() => {
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
      }, 10);

      for await (const _ of runtime.resume('pod-abc', 'continue the task', 'container-123')) {
        /* consume */
      }

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'container-123',
        [
          'sh',
          '/run/autopod/agent-shim.sh',
          'codex',
          'exec',
          'resume',
          'session-from-db-xyz',
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
          'continue the task',
        ],
        expect.any(Object),
      );
    });

    it('uses exec resume subcommand when pod has sessionId in in-memory map', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      // DB returns null but the in-memory map has the session ID
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo(null));
      runtime.codexSessionIds.set('pod-xyz', 'in-memory-session-id');

      setTimeout(() => {
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
      }, 10);

      for await (const _ of runtime.resume('pod-xyz', 'continue', 'container-123')) {
        /* consume */
      }

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'container-123',
        [
          'sh',
          '/run/autopod/agent-shim.sh',
          'codex',
          'exec',
          'resume',
          'in-memory-session-id',
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
          'continue',
        ],
        expect.any(Object),
      );
    });

    it('in-memory map takes priority over DB session ID', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo('db-session-id'));
      runtime.codexSessionIds.set('pod-priority', 'map-session-id');

      setTimeout(() => {
        // biome-ignore lint/suspicious/noExplicitAny: accessing test helper method
        (handle as any).finish(0);
      }, 10);

      for await (const _ of runtime.resume('pod-priority', 'continue', 'container-123')) {
        /* consume */
      }

      const execArgs = (cm.execStreaming as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as string[];
      expect(execArgs).toContain('map-session-id');
      expect(execArgs).not.toContain('db-session-id');
    });
  });

  describe('abort', () => {
    it('calls handle.kill() for the tracked pod', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      (runtime as any).handles.set('sess-1', handle);

      await runtime.abort('sess-1');

      expect(handle.kill).toHaveBeenCalled();
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      expect((runtime as any).handles.has('sess-1')).toBe(false);
    });

    it('is a no-op when no handle is tracked', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());
      await runtime.abort('nonexistent');
    });

    it('clears stored MCP servers and custom instructions for the aborted pod', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      (runtime as any).handles.set('sess-1', handle);
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      (runtime as any).mcpServersBySession.set('sess-1', [
        { name: 'escalation', url: 'http://h/mcp' },
      ]);
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      (runtime as any).customInstructionsBySession.set('sess-1', '# Autopod Pod');

      await runtime.abort('sess-1');

      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      expect((runtime as any).mcpServersBySession.has('sess-1')).toBe(false);
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      expect((runtime as any).customInstructionsBySession.has('sess-1')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // writeMcpConfig
  // ---------------------------------------------------------------------------

  describe('writeMcpConfig', () => {
    type WriteMcp = (containerId: string, mcpServers: SpawnConfig['mcpServers']) => Promise<void>;

    function callWriteMcpConfig(runtime: CodexRuntime): WriteMcp {
      return (runtime as unknown as { writeMcpConfig: WriteMcp }).writeMcpConfig.bind(runtime);
    }

    function lastWrittenContent(cm: ContainerManager): string {
      const calls = (cm.writeFile as ReturnType<typeof vi.fn>).mock.calls;
      const last = calls[calls.length - 1];
      return last?.[2] as string;
    }

    it('writes a streamable HTTP entry to ~/.codex/config.toml', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      await callWriteMcpConfig(runtime)('c1', [
        {
          name: 'escalation',
          url: 'http://host.docker.internal:3100/mcp/abc',
          headers: { Authorization: 'Bearer tok123' },
        },
      ]);

      expect(cm.writeFile).toHaveBeenCalledWith(
        'c1',
        '/home/autopod/.codex/config.toml',
        expect.any(String),
      );

      const written = lastWrittenContent(cm);
      expect(written).toContain('[mcp_servers.escalation]');
      expect(written).toContain('url = "http://host.docker.internal:3100/mcp/abc"');
      expect(written).toContain('http_headers = { Authorization = "Bearer tok123" }');
      expect(written).toContain('tool_timeout_sec = 3900.0');
      // HTTP entries must not emit stdio fields.
      expect(written).not.toContain('command =');
    });

    it('emits stdio entries with command/args/env (not url)', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      await callWriteMcpConfig(runtime)('c1', [
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

      const written = lastWrittenContent(cm);
      expect(written).toContain('[mcp_servers.serena]');
      expect(written).toContain('command = "serena"');
      expect(written).toContain('args = ["--project", "/workspace"]');
      expect(written).toContain('[mcp_servers.roslyn-codelens]');
      expect(written).toContain('command = "roslyn-codelens-mcp"');
      expect(written).toContain('env = { LOG_LEVEL = "info" }');
      expect(written).toContain('tool_timeout_sec = 3900.0');
      expect(written).not.toContain('url =');
      expect(written).not.toContain('http_headers =');
    });

    it('mixes http and stdio entries in the same config file', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      await callWriteMcpConfig(runtime)('c1', [
        { name: 'escalation', url: 'http://h/mcp' },
        { type: 'stdio', name: 'serena', command: 'serena' },
      ]);

      const written = lastWrittenContent(cm);
      expect(written).toContain('[mcp_servers.escalation]');
      expect(written).toContain('url = "http://h/mcp"');
      expect(written).toContain('[mcp_servers.serena]');
      expect(written).toContain('command = "serena"');
    });

    it('quotes server names that contain TOML-reserved characters', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      await callWriteMcpConfig(runtime)('c1', [{ name: 'name.with.dots', url: 'http://h/mcp' }]);

      const written = lastWrittenContent(cm);
      expect(written).toContain('[mcp_servers."name.with.dots"]');
    });

    it('escapes double quotes and backslashes in string values', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      await callWriteMcpConfig(runtime)('c1', [
        {
          name: 'escalation',
          url: 'http://h/mcp',
          headers: { 'X-Quote': 'a"b\\c' },
        },
      ]);

      const written = lastWrittenContent(cm);
      expect(written).toContain('X-Quote = "a\\"b\\\\c"');
    });

    it('does not write a config when mcpServers is empty', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      await callWriteMcpConfig(runtime)('c1', []);

      expect(cm.writeFile).not.toHaveBeenCalled();
    });

    it('does not write a config when mcpServers is undefined', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      await callWriteMcpConfig(runtime)('c1', undefined);

      expect(cm.writeFile).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // spawn / resume MCP wiring
  // ---------------------------------------------------------------------------

  describe('spawn / resume MCP wiring', () => {
    it('writes MCP config and stores servers in the session map on spawn', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      const iter = runtime.spawn({
        podId: 'sess-1',
        task: 'do thing',
        model: 'gpt-5-codex',
        workDir: '/workspace',
        containerId: 'c1',
        env: {},
        mcpServers: [{ name: 'escalation', url: 'http://h/mcp' }],
      });

      // Start consuming so spawn() advances past the writeMcpConfig + execStreaming call.
      const consume = (async () => {
        for await (const _ of iter) {
          // drain
        }
      })();
      (handle as unknown as { finish: (c?: number) => void }).finish(0);
      await consume;

      expect(cm.writeFile).toHaveBeenCalledWith(
        'c1',
        '/home/autopod/.codex/config.toml',
        expect.stringContaining('[mcp_servers.escalation]'),
      );
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      const stored = (runtime as any).mcpServersBySession.get('sess-1');
      expect(stored).toEqual([{ name: 'escalation', url: 'http://h/mcp' }]);
    });

    it('re-writes MCP config from the stored map on resume', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      // Simulate a prior spawn that populated the map.
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      (runtime as any).mcpServersBySession.set('sess-1', [
        { name: 'escalation', url: 'http://h/mcp' },
      ]);

      const iter = runtime.resume('sess-1', 'continue', 'c2', {});

      const consume = (async () => {
        for await (const _ of iter) {
          // drain
        }
      })();
      (handle as unknown as { finish: (c?: number) => void }).finish(0);
      await consume;

      // writeFile should target c2 (the new container) with the same config shape.
      expect(cm.writeFile).toHaveBeenCalledWith(
        'c2',
        '/home/autopod/.codex/config.toml',
        expect.stringContaining('[mcp_servers.escalation]'),
      );
    });

    it('resume skips writeFile entirely when no servers were stored', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());

      const iter = runtime.resume('sess-1', 'continue', 'c2', {});

      const consume = (async () => {
        for await (const _ of iter) {
          // drain
        }
      })();
      (handle as unknown as { finish: (c?: number) => void }).finish(0);
      await consume;

      expect(cm.writeFile).not.toHaveBeenCalled();
    });

    it('suspend preserves the mcpServersBySession entry', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      (runtime as any).handles.set('sess-1', handle);
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      (runtime as any).mcpServersBySession.set('sess-1', [
        { name: 'escalation', url: 'http://h/mcp' },
      ]);

      await runtime.suspend('sess-1');

      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      expect((runtime as any).mcpServersBySession.has('sess-1')).toBe(true);
    });
  });
});
