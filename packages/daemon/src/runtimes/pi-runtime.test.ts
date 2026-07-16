import { PassThrough } from 'node:stream';
import type { AgentEvent, SpawnConfig } from '@autopod/shared';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { PiRuntime } from './pi-runtime.js';

const logger = pino({ level: 'silent' });

interface TestHandle extends StreamingExecResult {
  stdin: PassThrough;
  finish(code?: number): void;
}

function createHandle(): TestHandle {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let resolveExitCode: (code: number) => void = () => undefined;
  const exitCode = new Promise<number>((resolve) => {
    resolveExitCode = resolve;
  });
  return {
    stdout,
    stderr,
    stdin,
    exitCode,
    kill: vi.fn(async () => {
      stdout.end();
      stderr.end();
      stdin.end();
      resolveExitCode(137);
    }),
    finish(code = 0) {
      stdout.end();
      stderr.end();
      resolveExitCode(code);
    },
  };
}

function createContainerManager(handles: TestHandle[]): ContainerManager {
  return {
    spawn: vi.fn(),
    kill: vi.fn(),
    stop: vi.fn(),
    start: vi.fn(),
    refreshFirewall: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    readFileBinary: vi.fn(),
    extractDirectoryFromContainer: vi.fn(),
    getStatus: vi.fn(async () => 'running' as const),
    execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    execStreaming: vi.fn(async () => {
      const handle = handles.shift();
      if (!handle) throw new Error('no handle');
      return handle;
    }),
  } as unknown as ContainerManager;
}

function config(overrides: Partial<SpawnConfig> = {}): SpawnConfig {
  return {
    podId: 'pod-1',
    task: 'initial task',
    model: 'claude-sonnet-4',
    workDir: '/workspace',
    containerId: 'ctr-1',
    customInstructions: 'system instructions',
    env: { AUTOPOD_PI_PROVIDER_ID: 'anthropic' },
    mcpServers: [{ name: 'escalation', url: 'http://daemon/mcp' }],
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('PiRuntime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the initial prompt through trusted managed-worker flags', async () => {
    const handle = createHandle();
    const cm = createContainerManager([handle]);
    const runtime = new PiRuntime(logger, cm);

    const eventsPromise = collect(runtime.spawn(config()));
    handle.stdout.write(
      `${JSON.stringify({ type: 'response', id: 'pod-1:1', result: { sessionId: 'pi-s1' } })}\n`,
    );
    handle.stdout.write(`${JSON.stringify({ type: 'complete', result: 'done' })}\n`);
    handle.finish(0);

    await expect(eventsPromise).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'complete', result: 'done' })]),
    );
    expect(cm.writeFile).toHaveBeenCalledWith(
      'ctr-1',
      '/home/autopod/.pi/autopod-worker.json',
      expect.stringContaining('"requiredServerName": "escalation"'),
    );
    expect(cm.execStreaming).toHaveBeenCalledWith(
      'ctr-1',
      expect.arrayContaining([
        'pi',
        'rpc',
        '--worker-package',
        '@autopod/pi-worker',
        '--disable-project-extensions',
        '--disable-executable-project-resources',
        '--system-prompt-file',
        '/home/autopod/.autopod/system-instructions.md',
        '--jsonl',
      ]),
      expect.objectContaining({ cwd: '/workspace', stdin: true }),
    );
    expect(handle.stdin.read()?.toString('utf-8')).toBe(
      `${JSON.stringify({
        id: 'pod-1:1',
        method: 'prompt',
        params: { message: 'initial task', model: 'claude-sonnet-4' },
      })}\n`,
    );
  });

  it('preserves the Pi session for same-session follow-up and suspend', async () => {
    const first = createHandle();
    const second = createHandle();
    const cm = createContainerManager([first, second]);
    const runtime = new PiRuntime(logger, cm);

    const spawnEvents = collect(runtime.spawn(config({ workDir: '/workspace/packages/service' })));
    first.stdout.write(
      `${JSON.stringify({ type: 'response', id: 'pod-1:1', result: { sessionId: 'pi-s1' } })}\n`,
    );
    first.stdout.write(`${JSON.stringify({ type: 'complete', result: 'done' })}\n`);
    first.finish(0);
    await spawnEvents;

    const resumeEvents = collect(runtime.resume('pod-1', 'follow up', 'ctr-1', { FRESH: '1' }));
    second.stdout.write(
      `${JSON.stringify({ type: 'response', id: 'pod-1:2', result: { sessionId: 'pi-s1' } })}\n`,
    );
    second.stdout.write(`${JSON.stringify({ type: 'complete', result: 'done again' })}\n`);
    second.finish(0);
    await resumeEvents;

    expect(cm.execStreaming).toHaveBeenLastCalledWith(
      'ctr-1',
      expect.arrayContaining(['rpc', '--jsonl']),
      expect.objectContaining({
        cwd: '/workspace/packages/service',
        env: { FRESH: '1' },
        stdin: true,
      }),
    );
    expect(second.stdin.read()?.toString('utf-8')).toBe(
      `${JSON.stringify({
        id: 'pod-1:2',
        method: 'follow-up',
        params: { message: 'follow up', model: 'claude-sonnet-4', sessionId: 'pi-s1' },
      })}\n`,
    );

    const suspendHandle = createHandle();
    const cm2 = createContainerManager([suspendHandle]);
    const runtime2 = new PiRuntime(logger, cm2);
    const running = collect(runtime2.spawn(config()));
    await waitFor(() => vi.mocked(cm2.execStreaming).mock.calls.length === 1);
    suspendHandle.stdout.write(
      `${JSON.stringify({ type: 'response', id: 'pod-1:1', result: { sessionId: 'pi-s2' } })}\n`,
    );
    await runtime2.suspend('pod-1');
    await running;
    expect(runtime2.getPiSessionId('pod-1')).toBe('pi-s2');
  });

  it('terminates a long-lived RPC process after terminal agent evidence', async () => {
    const handle = createHandle();
    const cm = createContainerManager([handle]);
    const runtime = new PiRuntime(logger, cm);

    const eventsPromise = collect(runtime.spawn(config()));
    handle.stdout.write(
      `${JSON.stringify({ type: 'response', id: 'pod-1:1', result: { sessionId: 'pi-s1' } })}\n`,
    );
    handle.stdout.write(`${JSON.stringify({ type: 'complete', result: 'done' })}\n`);

    const events = await eventsPromise;

    expect(events.some((event) => event.type === 'complete')).toBe(true);
    expect(handle.kill).toHaveBeenCalledOnce();
  });

  it('terminates the RPC process when stream parsing fails', async () => {
    const handle = createHandle();
    const cm = createContainerManager([handle]);
    const runtime = new PiRuntime(logger, cm);
    const events = collect(runtime.spawn(config()));
    await waitFor(() => vi.mocked(cm.execStreaming).mock.calls.length === 1);

    handle.stdout.destroy(new Error('broken RPC stream'));

    await expect(events).rejects.toThrow('broken RPC stream');
    expect(handle.kill).toHaveBeenCalledOnce();
  });

  it('resumes from primed durable session state after runtime restart', async () => {
    const handle = createHandle();
    const cm = createContainerManager([handle]);
    const runtime = new PiRuntime(logger, cm);
    runtime.setPiSessionId('pod-1', 'durable-pi-session');
    runtime.setPiResumeConfig(config());

    const resumeEvents = collect(runtime.resume('pod-1', 'continue after restart', 'ctr-1'));
    handle.stdout.write(
      `${JSON.stringify({
        type: 'response',
        id: 'pod-1:1',
        result: { sessionId: 'durable-pi-session' },
      })}\n`,
    );
    handle.stdout.write(`${JSON.stringify({ type: 'complete', result: 'recovered' })}\n`);
    handle.finish(0);

    await expect(resumeEvents).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'complete', result: 'recovered' })]),
    );
    expect(cm.execStreaming).toHaveBeenCalledWith(
      'ctr-1',
      expect.arrayContaining(['rpc', '--jsonl']),
      expect.objectContaining({ cwd: '/workspace' }),
    );
    expect(handle.stdin.read()?.toString('utf-8')).toBe(
      `${JSON.stringify({
        id: 'pod-1:1',
        method: 'follow-up',
        params: {
          message: 'continue after restart',
          model: 'claude-sonnet-4',
          sessionId: 'durable-pi-session',
        },
      })}\n`,
    );
  });

  it('abort terminates the process and clears resumable state', async () => {
    const handle = createHandle();
    const cm = createContainerManager([handle]);
    const runtime = new PiRuntime(logger, cm);
    const running = collect(runtime.spawn(config()));
    await waitFor(() => vi.mocked(cm.execStreaming).mock.calls.length === 1);
    handle.stdout.write(
      `${JSON.stringify({ type: 'response', id: 'pod-1:1', result: { sessionId: 'pi-s1' } })}\n`,
    );

    await runtime.abort('pod-1');
    await running;

    expect(handle.kill).toHaveBeenCalled();
    expect(runtime.getPiSessionId('pod-1')).toBeUndefined();
  });

  it('rejects clean status-only exits as false completion', async () => {
    const handle = createHandle();
    const cm = createContainerManager([handle]);
    const runtime = new PiRuntime(logger, cm);

    const eventsPromise = collect(runtime.spawn(config()));
    handle.stdout.write(
      `${JSON.stringify({ type: 'response', id: 'pod-1:1', result: { sessionId: 'pi-s1' } })}\n`,
    );
    handle.stdout.write(`${JSON.stringify({ type: 'status', message: 'accepted' })}\n`);
    handle.finish(0);

    await expect(eventsPromise).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          fatal: true,
          message: 'Pi process exited without terminal agent evidence',
        }),
      ]),
    );
  });

  it('surfaces process failure as fatal', async () => {
    const handle = createHandle();
    const cm = createContainerManager([handle]);
    const runtime = new PiRuntime(logger, cm);

    const eventsPromise = collect(runtime.spawn(config()));
    handle.stdout.write(
      `${JSON.stringify({ type: 'response', id: 'pod-1:1', result: { sessionId: 'pi-s1' } })}\n`,
    );
    handle.stdout.write(`${JSON.stringify({ type: 'text', text: 'working' })}\n`);
    handle.finish(2);

    await expect(eventsPromise).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          fatal: true,
          message: 'Pi process exited with code 2',
        }),
      ]),
    );
  });
});
