import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { EventEmitter, Readable } from 'node:stream';
import { CodexRuntime } from './codex-runtime.js';

const logger = pino({ level: 'silent' });

// Mock child process that simulates codex CLI
function createMockProcess(options?: { exitCode?: number; ignoreSignals?: boolean }) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as any;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.pid = 12345;
  proc.killed = false;
  proc.exitCode = null;

  proc.kill = vi.fn((signal?: string) => {
    if (options?.ignoreSignals && signal === 'SIGTERM') return;
    proc.killed = true;
    proc.exitCode = options?.exitCode ?? 0;
    process.nextTick(() => proc.emit('exit', proc.exitCode));
  });

  // Helper: end stdout and emit process exit (simulates normal completion)
  proc.finish = (code?: number) => {
    proc.stdout.push(null);
    const exitCode = code ?? options?.exitCode ?? 0;
    proc.exitCode = exitCode;
    process.nextTick(() => proc.emit('exit', exitCode));
  };

  return proc;
}

function createMockSpawn(mockProc: any) {
  return vi.fn(() => mockProc) as any;
}

describe('CodexRuntime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildSpawnArgs', () => {
    it('builds correct args from config', () => {
      const runtime = new CodexRuntime(logger);
      const args = (runtime as any).buildSpawnArgs({
        sessionId: 'abc123',
        task: 'Fix the bug',
        model: 'o3-mini',
        workDir: '/workspace',
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
    it('spawns codex process and yields events from stdout', async () => {
      const mockProc = createMockProcess();
      const spawnFn = createMockSpawn(mockProc);
      const runtime = new CodexRuntime(logger, spawnFn);

      setTimeout(() => {
        mockProc.stdout.push('{"type":"task_start","message":"Starting"}\n');
        mockProc.stdout.push('{"type":"task_complete","result":"Done"}\n');
        mockProc.finish(0);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        sessionId: 'test-sess',
        task: 'Do the thing',
        model: 'o3-mini',
        workDir: '/workspace',
        env: {},
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('status');
      expect(events[1].type).toBe('complete');

      expect(spawnFn).toHaveBeenCalledWith(
        'codex',
        ['exec', 'Do the thing', '--model', 'o3-mini', '--full-auto', '--json'],
        expect.objectContaining({ cwd: '/workspace' }),
      );
    });

    it('yields error event on non-zero exit code', async () => {
      const mockProc = createMockProcess({ exitCode: 1 });
      const runtime = new CodexRuntime(logger, createMockSpawn(mockProc));

      setTimeout(() => {
        mockProc.finish(1);
      }, 10);

      const events = [];
      for await (const event of runtime.spawn({
        sessionId: 'test-sess',
        task: 'Fail',
        model: 'o3-mini',
        workDir: '/workspace',
        env: {},
      })) {
        events.push(event);
      }

      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent as any).message).toContain('exited with code 1');
      expect((errorEvent as any).fatal).toBe(true);
    });

    it('cleans up process tracking after completion', async () => {
      const mockProc = createMockProcess();
      const runtime = new CodexRuntime(logger, createMockSpawn(mockProc));

      setTimeout(() => {
        mockProc.finish(0);
      }, 10);

      for await (const _ of runtime.spawn({
        sessionId: 'track-test',
        task: 'test',
        model: 'o3-mini',
        workDir: '/workspace',
        env: {},
      })) { /* consume */ }

      expect((runtime as any).processes.has('track-test')).toBe(false);
    });
  });

  describe('resume', () => {
    it('spawns codex with message as task in full-auto mode', async () => {
      const mockProc = createMockProcess();
      const spawnFn = createMockSpawn(mockProc);
      const runtime = new CodexRuntime(logger, spawnFn);

      setTimeout(() => {
        mockProc.stdout.push('{"type":"task_complete","result":"Fixed"}\n');
        mockProc.stdout.push(null);
      }, 10);

      const events = [];
      for await (const event of runtime.resume('sess-1', 'Fix the validation errors')) {
        events.push(event);
      }

      expect(spawnFn).toHaveBeenCalledWith(
        'codex',
        ['exec', 'Fix the validation errors', '--full-auto', '--json'],
        expect.any(Object),
      );
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('complete');
    });
  });

  describe('abort', () => {
    it('sends SIGTERM to the tracked process', async () => {
      const mockProc = createMockProcess();
      const runtime = new CodexRuntime(logger);
      (runtime as any).processes.set('sess-1', mockProc);

      await runtime.abort('sess-1');

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect((runtime as any).processes.has('sess-1')).toBe(false);
    });

    it('is a no-op when no process is tracked', async () => {
      const runtime = new CodexRuntime(logger);
      await runtime.abort('nonexistent');
    });

    it('sends SIGKILL after timeout if SIGTERM is ignored', async () => {
      vi.useFakeTimers();
      const mockProc = createMockProcess({ ignoreSignals: true });
      const runtime = new CodexRuntime(logger);
      (runtime as any).processes.set('sess-1', mockProc);

      const abortPromise = runtime.abort('sess-1');

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockProc.kill).not.toHaveBeenCalledWith('SIGKILL');

      vi.advanceTimersByTime(5_000);

      expect(mockProc.kill).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();

      // Resolve the abort promise by emitting exit
      mockProc.killed = true;
      mockProc.exitCode = 137;
      mockProc.emit('exit', 137);
      await abortPromise;
    });
  });
});
