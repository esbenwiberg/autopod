import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { PassThrough } from 'node:stream';
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
      resolveExitCode!(options?.exitCode ?? 137);
    }),
  };

  // Helper to finish the stream: push null on stdout and resolve exitCode
  (handle as any).finish = (code?: number) => {
    stdout.push(null);
    resolveExitCode!(code ?? options?.exitCode ?? 0);
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
      const args = (runtime as any).buildSpawnArgs({
        sessionId: 'abc123',
        task: 'Fix the bug',
        model: 'o3-mini',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      });
      expect(args).toEqual([
        'exec', 'Fix the bug',
        '--model', 'o3-mini',
        '--full-auto', '--json',
      ]);
    });
  });

  describe('spawn', () => {
    it('calls execStreaming and yields events from stdout', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm);

      setTimeout(() => {
        (handle.stdout as PassThrough).write('{"type":"task_start","message":"Starting"}\n');
        (handle.stdout as PassThrough).write('{"type":"task_complete","result":"Done"}\n');
        (handle as any).finish(0);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        sessionId: 'test-sess',
        task: 'Do the thing',
        model: 'o3-mini',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe('status');
      expect(events[1]!.type).toBe('complete');

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'container-123',
        ['codex', 'exec', 'Do the thing', '--model', 'o3-mini', '--full-auto', '--json'],
        expect.objectContaining({ cwd: '/workspace' }),
      );
    });

    it('yields error event on non-zero exit code', async () => {
      const handle = createMockHandle({ exitCode: 1 });
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm);

      setTimeout(() => {
        (handle as any).finish(1);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        sessionId: 'test-sess',
        task: 'Fail',
        model: 'o3-mini',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) {
        events.push(event);
      }

      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent as any).message).toContain('exited with code 1');
      expect((errorEvent as any).fatal).toBe(true);
    });

    it('cleans up handle tracking after completion', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm);

      setTimeout(() => {
        (handle as any).finish(0);
      }, 10);

      for await (const _ of runtime.spawn({
        sessionId: 'track-test',
        task: 'test',
        model: 'o3-mini',
        workDir: '/workspace',
        containerId: 'container-123',
        env: {},
      })) { /* consume */ }

      expect((runtime as any).handles.has('track-test')).toBe(false);
    });
  });

  describe('resume', () => {
    it('calls execStreaming with message as task in full-auto mode', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm);

      setTimeout(() => {
        (handle.stdout as PassThrough).write('{"type":"task_complete","result":"Fixed"}\n');
        (handle.stdout as PassThrough).push(null);
        // Resolve exitCode after stdout ends
        (handle as any).finish(0);
      }, 10);

      const events = [];
      for await (const event of runtime.resume('sess-1', 'Fix the validation errors', 'container-123')) {
        events.push(event);
      }

      expect(cm.execStreaming).toHaveBeenCalledWith(
        'container-123',
        ['codex', 'exec', 'Fix the validation errors', '--full-auto', '--json'],
        expect.any(Object),
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('complete');
    });
  });

  describe('abort', () => {
    it('calls handle.kill() for the tracked session', async () => {
      const handle = createMockHandle();
      const cm = createMockContainerManager(handle);
      const runtime = new CodexRuntime(logger, cm);
      (runtime as any).handles.set('sess-1', handle);

      await runtime.abort('sess-1');

      expect(handle.kill).toHaveBeenCalled();
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
