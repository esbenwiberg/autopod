import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamingExecResult } from '../interfaces/container-manager.js';
import { CodexGoalRuntimeSession } from './codex-goal-runtime-session.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const prepared = deferred<void>();
  const acquired = deferred<StreamingExecResult>();
  const prepare = vi.fn(() => prepared.promise);
  const spawn = vi.fn(() => acquired.promise);
  const stopped = vi.fn();
  const sessionOpened = vi.fn();
  const session = new CodexGoalRuntimeSession({
    config: { model: 'gpt-5.5', cwd: '/workspace', developerInstructions: '' },
    prepare,
    spawn,
    stopped,
    sessionOpened,
  });
  return { session, prepared, acquired, prepare, spawn, stopped, sessionOpened };
}

function processFixture() {
  const exited = deferred<number>();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const kill = vi.fn(async () => {
    stdout.end();
    stderr.end();
    exited.resolve(0);
  });
  return { stdout, stderr, stdin, kill, exitCode: exited.promise };
}

describe('lazy native Goal process ownership', () => {
  afterEach(() => vi.useRealTimers());

  it('cancels preparation before any native process can start', async () => {
    const h = fixture();
    const opened = expect(h.session.open(null)).rejects.toMatchObject({ code: 'PROCESS_CLOSED' });
    const stopped = h.session.stop();
    h.prepared.resolve();
    await Promise.all([opened, stopped]);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.sessionOpened).not.toHaveBeenCalled();
    await expect(h.session.open(null)).rejects.toMatchObject({ code: 'SESSION_ALREADY_OPEN' });
  });

  it('terminates a process acquired after cancellation without opening a native thread', async () => {
    const h = fixture();
    h.prepared.resolve();
    const opened = expect(h.session.open(null)).rejects.toMatchObject({ code: 'PROCESS_CLOSED' });
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1));
    const stopping = h.session.stop();
    const process = processFixture();
    const writes = vi.fn();
    process.stdin.on('data', writes);
    h.acquired.resolve(process);
    await Promise.all([opened, stopping]);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(h.stopped).toHaveBeenCalledTimes(1);
  });

  it('does not release ownership when process acquisition cannot be reconciled', async () => {
    const h = fixture();
    h.prepared.resolve();
    h.spawn.mockRejectedValue(new Error('transport ended during allocation'));
    await expect(h.session.open(null)).rejects.toThrow('transport ended');
    await expect(h.session.stop()).rejects.toMatchObject({ code: 'TERMINATION_UNCONFIRMED' });
    await expect(h.session.stop()).rejects.toMatchObject({ code: 'TERMINATION_UNCONFIRMED' });
    expect(h.stopped).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('bounds cancellation while waiting for an allocation and closes a late process', async () => {
    const h = fixture();
    vi.useFakeTimers();
    h.prepared.resolve();
    const opened = expect(h.session.open(null)).rejects.toMatchObject({ code: 'PROCESS_CLOSED' });
    await Promise.resolve();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const stopping = expect(h.session.stop()).rejects.toMatchObject({
      code: 'TERMINATION_UNCONFIRMED',
    });
    await vi.advanceTimersByTimeAsync(5001);
    await stopping;
    expect(h.stopped).not.toHaveBeenCalled();
    const process = processFixture();
    h.acquired.resolve(process);
    await opened;
    await vi.advanceTimersByTimeAsync(0);
    expect(process.kill).toHaveBeenCalledTimes(1);
    expect(h.stopped).toHaveBeenCalledTimes(1);
  });

  it('does not release a half-open process until its termination is confirmed', async () => {
    const h = fixture();
    const process = processFixture();
    process.kill.mockRejectedValueOnce(new Error('unconfirmed stop'));
    h.prepared.resolve();
    h.acquired.resolve({ ...process, stdin: undefined });
    await expect(h.session.open(null)).rejects.toMatchObject({ code: 'TERMINATION_UNCONFIRMED' });
    expect(h.stopped).not.toHaveBeenCalled();
    await h.session.stop();
    expect(process.kill).toHaveBeenCalledTimes(2);
    expect(h.stopped).toHaveBeenCalledTimes(1);
    expect(h.sessionOpened).not.toHaveBeenCalled();
  });
});
