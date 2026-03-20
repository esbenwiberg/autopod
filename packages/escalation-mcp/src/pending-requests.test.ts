import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingRequests } from './pending-requests.js';

describe('PendingRequests', () => {
  let pending: PendingRequests;

  beforeEach(() => {
    vi.useFakeTimers();
    pending = new PendingRequests();
  });

  afterEach(() => {
    pending.cancelAll();
    vi.useRealTimers();
  });

  it('should resolve a pending request', async () => {
    const promise = pending.waitForResponse('esc-1', 5000);

    expect(pending.hasPending('esc-1')).toBe(true);
    expect(pending.size).toBe(1);

    pending.resolve('esc-1', 'got it');

    const result = await promise;
    expect(result).toBe('got it');
    expect(pending.hasPending('esc-1')).toBe(false);
    expect(pending.size).toBe(0);
  });

  it('should reject a pending request', async () => {
    const promise = pending.waitForResponse('esc-2', 5000);

    pending.reject('esc-2', new Error('something broke'));

    await expect(promise).rejects.toThrow('something broke');
    expect(pending.size).toBe(0);
  });

  it('should time out after the specified duration', async () => {
    const promise = pending.waitForResponse('esc-3', 1000);

    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow('Escalation esc-3 timed out after 1000ms');
    expect(pending.hasPending('esc-3')).toBe(false);
  });

  it('should return false when resolving a non-existent request', () => {
    expect(pending.resolve('nope', 'hi')).toBe(false);
  });

  it('should return false when rejecting a non-existent request', () => {
    expect(pending.reject('nope', new Error('nah'))).toBe(false);
  });

  it('should cancel all pending requests', async () => {
    const p1 = pending.waitForResponse('esc-a', 5000);
    const p2 = pending.waitForResponse('esc-b', 5000);

    expect(pending.size).toBe(2);

    pending.cancelAll();

    await expect(p1).rejects.toThrow('All pending requests cancelled');
    await expect(p2).rejects.toThrow('All pending requests cancelled');
    expect(pending.size).toBe(0);
  });

  it('should handle multiple concurrent requests independently', async () => {
    const p1 = pending.waitForResponse('esc-x', 5000);
    const p2 = pending.waitForResponse('esc-y', 5000);

    pending.resolve('esc-x', 'response-x');

    expect(await p1).toBe('response-x');
    expect(pending.hasPending('esc-y')).toBe(true);

    pending.resolve('esc-y', 'response-y');
    expect(await p2).toBe('response-y');
  });
});
