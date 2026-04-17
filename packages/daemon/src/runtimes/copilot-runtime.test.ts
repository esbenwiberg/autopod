import { PassThrough } from 'node:stream';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { CopilotRuntime } from './copilot-runtime.js';

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

  (handle as { finish?: (code?: number) => void }).finish = (code?: number) => {
    stdout.push(null);
    stderr.push(null); // end stderr so stderrPromise resolves
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

describe('CopilotRuntime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildSpawnArgs', () => {
    it('builds correct args from config', () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CopilotRuntime(logger, cm);
      const args = (runtime as { buildSpawnArgs: (c: unknown) => string[] }).buildSpawnArgs({
        podId: 'abc123',
        task: 'Fix the bug',
        model: 'claude-sonnet-4-5',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      });
      expect(args).toEqual([
        '-p',
        'Fix the bug',
        '--allow-all',
        '--no-ask-user',
        '--no-auto-update',
        '-s',
      ]);
    });
  });

  describe('spawn', () => {
    it('calls execStreaming with copilot binary and yields events', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CopilotRuntime(logger, cm);

      setTimeout(() => {
        (handle.stdout as PassThrough).write('Working on it...\n');
        (handle as { finish?: (code?: number) => void }).finish?.(0);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        podId: 'test-sess',
        task: 'Do the thing',
        model: 'claude-sonnet-4-5',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'container-123',
        expect.arrayContaining(['copilot', '-p', 'Do the thing']),
        expect.objectContaining({ cwd: '/workspace' }),
      );

      const statusEvents = events.filter((e) => e.type === 'status');
      expect(statusEvents.length).toBeGreaterThan(0);
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
    });

    it('sets COPILOT_HOME in env', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CopilotRuntime(logger, cm);

      setTimeout(() => {
        (handle as { finish?: (code?: number) => void }).finish?.(0);
      }, 10);

      for await (const _ of runtime.spawn({
        podId: 'env-test',
        task: 'test',
        model: 'sonnet',
        workDir: '/workspace',
        containerId: 'container-123',
        env: { COPILOT_GITHUB_TOKEN: 'gho_test' },
      })) {
        /* consume */
      }

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'container-123',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ COPILOT_HOME: '/home/autopod/.copilot' }),
        }),
      );
    });

    it('writes MCP config file when mcpServers provided', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CopilotRuntime(logger, cm);

      setTimeout(() => {
        (handle as { finish?: (code?: number) => void }).finish?.(0);
      }, 10);

      for await (const _ of runtime.spawn({
        podId: 'mcp-test',
        task: 'test',
        model: 'sonnet',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
        mcpServers: [{ name: 'escalation', url: 'http://localhost:3001/mcp' }],
      })) {
        /* consume */
      }

      expect(cm.writeFile).toHaveBeenCalledWith(
        'container-123',
        '/home/autopod/.copilot/mcp-config.json',
        expect.stringContaining('escalation'),
      );
    });

    it('writes instructions file when customInstructions provided', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CopilotRuntime(logger, cm);

      setTimeout(() => {
        (handle as { finish?: (code?: number) => void }).finish?.(0);
      }, 10);

      for await (const _ of runtime.spawn({
        podId: 'instr-test',
        task: 'test',
        model: 'sonnet',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
        customInstructions: 'Always write tests.',
      })) {
        /* consume */
      }

      expect(cm.writeFile).toHaveBeenCalledWith(
        'container-123',
        '/home/autopod/.copilot/copilot-instructions.md',
        'Always write tests.',
      );
    });

    it('yields error event on non-zero exit code', async () => {
      const handle = createMockHandle({ exitCode: 1 });
      const cm = createMockContainerManager(handle);
      const runtime = new CopilotRuntime(logger, cm);

      setTimeout(() => {
        (handle as { finish?: (code?: number) => void }).finish?.(1);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        podId: 'fail-test',
        task: 'fail',
        model: 'sonnet',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      const errorEvent = events.find((e) => e.type === 'error') as
        | { type: string; message: string; fatal: boolean }
        | undefined;
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.message).toContain('exited with code 1');
      expect(errorEvent?.fatal).toBe(true);
    });

    it('cleans up handle tracking after completion', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CopilotRuntime(logger, cm);

      setTimeout(() => {
        (handle as { finish?: (code?: number) => void }).finish?.(0);
      }, 10);

      for await (const _ of runtime.spawn({
        podId: 'track-test',
        task: 'test',
        model: 'sonnet',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        /* consume */
      }

      expect((runtime as { handles: Map<string, unknown> }).handles.has('track-test')).toBe(false);
    });
  });

  describe('resume', () => {
    it('yields a fatal error when called with no prior spawn config', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CopilotRuntime(logger, cm);

      const events = [];
      for await (const event of runtime.resume('sess-1', 'continue', 'container-123')) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'error', fatal: true });
    });

    it('respawns copilot with correction message after a prior spawn', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CopilotRuntime(logger, cm);

      // Seed the stored config by calling spawn first
      setTimeout(() => {
        (handle as { finish?: (code?: number) => void }).finish?.(0);
        (handle.stderr as PassThrough).push(null);
      }, 10);

      for await (const _ of runtime.spawn({
        podId: 'sess-resume',
        task: 'Original task',
        model: 'sonnet',
        workDir: '/workspace',
        containerId: 'container-123',
        env: { COPILOT_GITHUB_TOKEN: 'gho_test' },
      })) {
        /* consume */
      }

      // Now set up a fresh handle for the respawn
      const handle2 = createMockHandle();
      (cm.execStreaming as ReturnType<typeof vi.fn>).mockResolvedValueOnce(handle2);
      setTimeout(() => {
        (handle2 as { finish?: (code?: number) => void }).finish?.(0);
        (handle2.stderr as PassThrough).push(null);
      }, 10);

      const events = [];
      for await (const event of runtime.resume('sess-resume', 'Fix the build', 'container-123')) {
        events.push(event);
      }

      // Should have spawned copilot with the correction message
      expect(cm.execStreaming).toHaveBeenLastCalledWith(
        'container-123',
        expect.arrayContaining(['-p', 'Fix the build']),
        expect.any(Object),
      );
      const completeEvent = events.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
    });
  });

  describe('abort', () => {
    it('calls handle.kill() for the tracked pod', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CopilotRuntime(logger, cm);
      (runtime as { handles: Map<string, unknown> }).handles.set('sess-1', handle);

      await runtime.abort('sess-1');

      expect(handle.kill).toHaveBeenCalled();
      expect((runtime as { handles: Map<string, unknown> }).handles.has('sess-1')).toBe(false);
    });

    it('is a no-op when no handle is tracked', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CopilotRuntime(logger, cm);
      await runtime.abort('nonexistent');
    });
  });
});
