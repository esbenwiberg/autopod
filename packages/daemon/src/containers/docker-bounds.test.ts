import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOCKER_CALL_TIMEOUTS,
  DockerCallTimeoutError,
  boundedDockerCall,
} from './docker-bounds.js';

const logger = pino({ level: 'silent' });

describe('boundedDockerCall', () => {
  beforeEach(() => {
    vi.useRealTimers();
    // biome-ignore lint/performance/noDelete: must actually unset, '= undefined' stringifies to "undefined"
    delete process.env.AUTOPOD_DOCKER_CALL_TIMEOUT_MS;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: must actually unset, '= undefined' stringifies to "undefined"
    delete process.env.AUTOPOD_DOCKER_CALL_TIMEOUT_MS;
  });

  it('resolves with the underlying value when the promise settles before the timeout', async () => {
    const result = await boundedDockerCall(Promise.resolve('ok'), {
      label: 'test.fast',
      timeoutMs: 1000,
      logger,
    });
    expect(result).toBe('ok');
  });

  it('propagates the underlying rejection unchanged', async () => {
    const realErr = new Error('boom');
    await expect(
      boundedDockerCall(Promise.reject(realErr), {
        label: 'test.reject',
        timeoutMs: 1000,
        logger,
      }),
    ).rejects.toBe(realErr);
  });

  it('throws DockerCallTimeoutError when the promise hangs past the timeout', async () => {
    const start = Date.now();
    const neverResolves = new Promise(() => {});
    await expect(
      boundedDockerCall(neverResolves, {
        label: 'test.hang',
        timeoutMs: 50,
        logger,
        containerId: 'cid-xyz',
      }),
    ).rejects.toBeInstanceOf(DockerCallTimeoutError);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('records label, timeout, and containerId on the timeout error', async () => {
    const neverResolves = new Promise(() => {});
    try {
      await boundedDockerCall(neverResolves, {
        label: 'test.tagged',
        timeoutMs: 30,
        logger,
        containerId: 'abc123',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DockerCallTimeoutError);
      const dockerErr = err as DockerCallTimeoutError;
      expect(dockerErr.label).toBe('test.tagged');
      expect(dockerErr.timeoutMs).toBe(30);
      expect(dockerErr.containerId).toBe('abc123');
      expect(dockerErr.message).toContain('test.tagged');
      expect(dockerErr.message).toContain('30ms');
      expect(dockerErr.message).toContain('abc123');
    }
  });

  it('respects AUTOPOD_DOCKER_CALL_TIMEOUT_MS env override', async () => {
    process.env.AUTOPOD_DOCKER_CALL_TIMEOUT_MS = '20';
    const start = Date.now();
    await expect(
      boundedDockerCall(new Promise(() => {}), {
        label: 'test.env-override',
        // Per-call default is 60s — env should override down to 20ms
        timeoutMs: 60_000,
        logger,
      }),
    ).rejects.toBeInstanceOf(DockerCallTimeoutError);
    const elapsed = Date.now() - start;
    // Env override of 20ms should fire long before the 60_000ms per-call default.
    expect(elapsed).toBeLessThan(500);
  });

  it('does not produce an unhandled rejection if the underlying promise rejects after the timeout fires', async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', handler);

    let rejectInner!: (err: Error) => void;
    const slowReject = new Promise((_resolve, reject) => {
      rejectInner = reject;
    });

    await expect(
      boundedDockerCall(slowReject, {
        label: 'test.late-reject',
        timeoutMs: 20,
        logger,
      }),
    ).rejects.toBeInstanceOf(DockerCallTimeoutError);

    // Reject the inner promise AFTER we've already given up. This is the
    // dockerd-finally-responds-too-late case — must not produce an unhandled
    // rejection.
    rejectInner(new Error('late dockerd error'));

    // Give the microtask queue + any unhandled-rejection detection a beat.
    await new Promise((r) => setTimeout(r, 50));

    process.off('unhandledRejection', handler);
    expect(unhandled).toEqual([]);
  });

  it('clears its timer when the promise resolves quickly (no leaked handles)', async () => {
    // Spy on clearTimeout to confirm we cancel the timer on the success path.
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await boundedDockerCall(Promise.resolve(42), {
      label: 'test.quick',
      timeoutMs: 1000,
      logger,
    });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('exposes sane per-operation defaults', () => {
    // Smoke check — these are referenced from many call sites; making sure
    // the keys exist and are positive numbers prevents accidental deletions.
    for (const key of Object.keys(DOCKER_CALL_TIMEOUTS) as Array<
      keyof typeof DOCKER_CALL_TIMEOUTS
    >) {
      const val = DOCKER_CALL_TIMEOUTS[key];
      expect(val).toBeGreaterThan(0);
      expect(Number.isFinite(val)).toBe(true);
    }
  });
});
