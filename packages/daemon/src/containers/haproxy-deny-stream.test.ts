import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager, StreamingExecResult } from '../interfaces/container-manager.js';
import { unverifiedExecExit } from './exec-exit-evidence.js';
import { type DeniedConnection, streamHaproxyDenials } from './haproxy-deny-stream.js';

function makeStreamingResult(): {
  stdout: PassThrough;
  result: StreamingExecResult;
  resolveExit: (code: number) => void;
  rejectExit: (error: Error) => void;
  kill: ReturnType<typeof vi.fn>;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExit!: (code: number) => void;
  let rejectExit!: (error: Error) => void;
  const exitCode = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const kill = vi.fn(async () => {
    stdout.end();
    stderr.end();
    resolveExit(0);
  });
  return {
    stdout,
    resolveExit,
    rejectExit,
    kill,
    result: { stdout, stderr, exitCode, kill },
  };
}

function makeContainerManager(streamingResult: StreamingExecResult): ContainerManager {
  // Only execStreaming is used by the function under test; everything else is unused.
  return {
    execStreaming: vi.fn(async () => streamingResult),
  } as unknown as ContainerManager;
}

describe('streamHaproxyDenials', () => {
  const logger = pino({ level: 'silent' });
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('emits a denied event for each DENY line', async () => {
    const { stdout, result } = makeStreamingResult();
    const containerManager = makeContainerManager(result);
    const events: DeniedConnection[] = [];
    const handle = await streamHaproxyDenials(
      containerManager,
      'c1',
      (e) => events.push(e),
      logger,
    );

    stdout.write(
      '<134>May 12 20:47:25 haproxy[1]: sni=evil.example.com src=127.0.0.1 action=DENY\n',
    );
    stdout.write('<134>May 12 20:47:26 haproxy[1]: sni=bad.test src=10.0.0.5 action=DENY\n');
    await new Promise((r) => setImmediate(r));

    expect(events).toEqual([
      { sni: 'evil.example.com', src: '127.0.0.1' },
      { sni: 'bad.test', src: '10.0.0.5' },
    ]);

    await handle.stop();
  });

  it('ignores ALLOW lines', async () => {
    const { stdout, result } = makeStreamingResult();
    const containerManager = makeContainerManager(result);
    const events: DeniedConnection[] = [];
    const handle = await streamHaproxyDenials(
      containerManager,
      'c1',
      (e) => events.push(e),
      logger,
    );

    stdout.write(
      '<134>May 12 20:47:25 haproxy[1]: sni=api.anthropic.com src=127.0.0.1 action=ALLOW\n',
    );
    await new Promise((r) => setImmediate(r));

    expect(events).toEqual([]);

    await handle.stop();
  });

  it('handles partial / multi-line chunks correctly', async () => {
    const { stdout, result } = makeStreamingResult();
    const containerManager = makeContainerManager(result);
    const events: DeniedConnection[] = [];
    const handle = await streamHaproxyDenials(
      containerManager,
      'c1',
      (e) => events.push(e),
      logger,
    );

    // Split a single line across two chunks
    stdout.write('<134>May 12 20:47:25 haproxy[1]: sni=evil.example.com');
    stdout.write(' src=127.0.0.1 action=DENY\n');
    // Two lines in one chunk
    stdout.write(
      '<134>May 12 20:47:26 haproxy[1]: sni=a src=1.2.3.4 action=DENY\n<134>May 12 20:47:27 haproxy[1]: sni=b src=5.6.7.8 action=DENY\n',
    );
    await new Promise((r) => setImmediate(r));

    expect(events.map((e) => e.sni)).toEqual(['evil.example.com', 'a', 'b']);

    await handle.stop();
  });

  it('swallows handler errors so one bad subscriber does not stop the stream', async () => {
    const { stdout, result } = makeStreamingResult();
    const containerManager = makeContainerManager(result);
    const seen: string[] = [];
    let firstCall = true;
    const handle = await streamHaproxyDenials(
      containerManager,
      'c1',
      (e) => {
        if (firstCall) {
          firstCall = false;
          throw new Error('boom');
        }
        seen.push(e.sni);
      },
      logger,
    );

    stdout.write('<134>: sni=first src=1.1.1.1 action=DENY\n');
    stdout.write('<134>: sni=second src=2.2.2.2 action=DENY\n');
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual(['second']);

    await handle.stop();
  });

  it('contains an unverified exit rejection without claiming a successful receiver exit', async () => {
    const { result, rejectExit } = makeStreamingResult();
    const warn = vi.spyOn(logger, 'warn');
    const handle = await streamHaproxyDenials(makeContainerManager(result), 'c1', () => {}, logger);
    const error = unverifiedExecExit();
    // The adapter handles its original promise, but detached consumers must
    // also handle their derived promise or Node terminates the daemon.
    void result.exitCode.catch(() => {});
    rejectExit(error);
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalledWith(
      { err: error, containerId: 'c1' },
      expect.stringContaining('denial visibility lost'),
    );
    await expect(result.exitCode).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
    await handle.stop();
    warn.mockRestore();
  });

  it('stop() is idempotent — calling twice does not throw', async () => {
    const { result, kill } = makeStreamingResult();
    const containerManager = makeContainerManager(result);
    const handle = await streamHaproxyDenials(containerManager, 'c1', () => {}, logger);

    await handle.stop();
    await handle.stop();

    expect(kill).toHaveBeenCalledTimes(1);
  });
});
