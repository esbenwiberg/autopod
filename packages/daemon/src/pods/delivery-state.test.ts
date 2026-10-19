import { describe, expect, it, vi } from 'vitest';
import { createDeliveryFixture } from '../test-utils/delivery-helpers.js';
import { createDeliveryProvider } from './delivery-state.js';
describe('single delivery state owners', () => {
  it('retains an unwrapped original factory when no ledger is wired and constructs lazily', () => {
    const f = createDeliveryFixture();
    const original = f.prCaptured.prManagerFactory;
    expect(createDeliveryProvider(original, { deliveryLedger: undefined }).prManagerFactory).toBe(
      original,
    );
    expect(createDeliveryProvider(undefined, f.podRepo).prManagerFactory).toBeUndefined();
    expect(original).not.toHaveBeenCalled();
    const wrapped = createDeliveryProvider(original, f.podRepo).prManagerFactory;
    expect(wrapped).not.toBe(original);
    expect(original).not.toHaveBeenCalled();
    wrapped?.(f.passContext().profile);
    expect(original).toHaveBeenCalledOnce();
  });
  it('serializes shared merge targets while independent targets progress', async () => {
    const f = createDeliveryFixture();
    const effects: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = f.queue.mergeQueue.enqueueMerge('repo', 'main', async () => {
      effects.push('a');
      await gate;
      effects.push('a-end');
    });
    const b = f.queue.mergeQueue.enqueueMerge('repo', 'main', async () => {
      effects.push('b');
    });
    const c = f.queue.mergeQueue.enqueueMerge('repo', 'other', async () => {
      effects.push('c');
    });
    await c;
    expect(effects).toEqual(['a', 'c']);
    release();
    await Promise.all([a, b]);
    expect(effects).toEqual(['a', 'c', 'a-end', 'b']);
  });
  it('stops and replaces coordinator ownership without overlapping a draining operation', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const old = vi.fn(async () => {
      await gate;
    });
    const replacement = vi.fn(async () => {});
    f.state.mergePolling.start('prepare', 60_000, old);
    await vi.advanceTimersByTimeAsync(0);
    f.state.mergePolling.start('prepare', 60_000, replacement);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(old).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement).toHaveBeenCalledOnce();
    f.state.mergePolling.stop('prepare');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(replacement).toHaveBeenCalledOnce();
    expect(f.state.DEFAULT_MERGE_POLL_INTERVAL_MS).toBe(60_000);
  });
});
