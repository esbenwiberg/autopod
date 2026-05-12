import { PassThrough } from 'node:stream';
import type { AgentErrorEvent, AgentEvent } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
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

describe('CodexRuntime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildSpawnArgs', () => {
    it('builds correct args from config', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm);
      // biome-ignore lint/suspicious/noExplicitAny: accessing private method in test
      const args = (runtime as any).buildSpawnArgs({
        podId: 'abc123',
        task: 'Fix the bug',
        model: 'o3-mini',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      });
      expect(args).toEqual(['exec', 'Fix the bug', '--model', 'o3-mini', '--full-auto', '--json']);
    });
  });

  describe('spawn', () => {
    it('calls execStreaming and yields events from stdout', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm);

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
          '--full-auto',
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
      const runtime = new CodexRuntime(logger, cm);

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
      const logObj = spawnCall![0] as Record<string, unknown>;
      const loggedArgs = logObj.args as string[];
      expect(loggedArgs[1]).toMatch(/^<task: 50000 bytes>$/);
      expect(JSON.stringify(logObj).includes(bigStr)).toBe(false);

      // Real args to execStreaming still contain the full task
      const execArgs = (cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
      expect(execArgs).toContain(bigStr);
    });

    it('yields error event on non-zero exit code', async () => {
      const handle = createMockHandle({ exitCode: 1 });
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm);

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
        const runtime = new CodexRuntime(logger, cm);

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
      const runtime = new CodexRuntime(logger, cm);

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
  });

  describe('resume', () => {
    it('redacts large message in resume log args', async () => {
      const bigStr = 'X'.repeat(50_000);
      const infoSpy = vi.spyOn(logger, 'info');

      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm);

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
          (c[0] as Record<string, unknown>).msg === 'Resuming codex with follow-up message in container',
      );
      expect(resumeCall).toBeDefined();
      const logObj = resumeCall![0] as Record<string, unknown>;
      const loggedArgs = logObj.args as string[];
      expect(loggedArgs[1]).toMatch(/^<task: 50000 bytes>$/);
      expect(JSON.stringify(logObj).includes(bigStr)).toBe(false);

      // Real args to execStreaming still contain the full message
      const execArgs = (cm.execStreaming as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
      expect(execArgs).toContain(bigStr);
    });

    it('calls execStreaming with message as task in full-auto mode', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm);

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
          '--full-auto',
          '--json',
        ],
        expect.any(Object),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('complete');
    });
  });

  describe('abort', () => {
    it('calls handle.kill() for the tracked pod', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm);
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
      const runtime = new CodexRuntime(logger, cm);
      await runtime.abort('nonexistent');
    });
  });
});
