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
        'Fix the bug',
        '--model',
        'o3-mini',
        '--dangerously-bypass-approvals-and-sandbox',
        '--json',
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
        'Fix the bug',
        '--dangerously-bypass-approvals-and-sandbox',
        '--json',
      ]);
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
          `${JSON.stringify({ id: '2', msg: { type: 'turn_complete', turn_id: 't1', last_agent_message: 'Done' } })}\n`,
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
      expect(events[0]?.type).toBe('status');
      expect(events[1]?.type).toBe('complete');

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'container-123',
        [
          '/run/autopod/agent-shim.sh',
          'codex',
          'exec',
          'Do the thing',
          '--model',
          'o3-mini',
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
        ],
        expect.objectContaining({ cwd: '/workspace' }),
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
      expect(loggedArgs[1]).toMatch(/^<task: 50000 bytes>$/);
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

    it('terminates within grace window when stdout never closes after turn_complete', async () => {
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
              msg: { type: 'turn_complete', turn_id: 't1', last_agent_message: 'Done' },
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
          `${JSON.stringify({ id: '2', msg: { type: 'turn_complete', turn_id: 't1', last_agent_message: 'Done' } })}\n`,
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
      expect(loggedArgs[1]).toMatch(/^<task: 50000 bytes>$/);
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
          `${JSON.stringify({ id: '1', msg: { type: 'turn_complete', turn_id: 't1', last_agent_message: 'Fixed' } })}\n`,
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
          '/run/autopod/agent-shim.sh',
          'codex',
          'exec',
          'Fix the validation errors',
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
        ],
        expect.any(Object),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('complete');
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
          '/run/autopod/agent-shim.sh',
          'codex',
          'exec',
          'resume',
          'session-from-db-xyz',
          'continue the task',
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
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
          '/run/autopod/agent-shim.sh',
          'codex',
          'exec',
          'resume',
          'in-memory-session-id',
          'continue',
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
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

    it('clears the mcpServersBySession entry for the aborted pod', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm, createMockPodRepo());
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      (runtime as any).handles.set('sess-1', handle);
      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      (runtime as any).mcpServersBySession.set('sess-1', [
        { name: 'escalation', url: 'http://h/mcp' },
      ]);

      await runtime.abort('sess-1');

      // biome-ignore lint/suspicious/noExplicitAny: accessing private field in test
      expect((runtime as any).mcpServersBySession.has('sess-1')).toBe(false);
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
