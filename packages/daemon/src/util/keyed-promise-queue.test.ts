import { describe, expect, it } from 'vitest';
import { KeyedPromiseQueue } from './keyed-promise-queue.js';

describe('KeyedPromiseQueue', () => {
  it('serializes calls with the same key', async () => {
    const queue = new KeyedPromiseQueue();
    const order: string[] = [];

    let resolveA: () => void;
    const aBlock = new Promise<void>((r) => {
      resolveA = r;
    });

    const a = queue.run('k', async () => {
      order.push('a:start');
      await aBlock;
      order.push('a:end');
    });
    const b = queue.run('k', async () => {
      order.push('b:start');
      order.push('b:end');
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['a:start']);

    // biome-ignore lint/style/noNonNullAssertion: assigned synchronously above
    resolveA!();
    await Promise.all([a, b]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs different keys concurrently', async () => {
    const queue = new KeyedPromiseQueue();
    const order: string[] = [];

    let resolveA: () => void;
    const aBlock = new Promise<void>((r) => {
      resolveA = r;
    });

    const a = queue.run('k1', async () => {
      order.push('a:start');
      await aBlock;
      order.push('a:end');
    });
    const b = queue.run('k2', async () => {
      order.push('b:start');
      order.push('b:end');
    });

    await b;
    expect(order).toEqual(['a:start', 'b:start', 'b:end']);

    // biome-ignore lint/style/noNonNullAssertion: assigned synchronously above
    resolveA!();
    await a;
    expect(order).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
  });

  it('advances the queue after a rejected task', async () => {
    const queue = new KeyedPromiseQueue();
    const order: string[] = [];

    const a = queue.run('k', async () => {
      order.push('a');
      throw new Error('boom');
    });
    const b = queue.run('k', async () => {
      order.push('b');
    });

    await expect(a).rejects.toThrow('boom');
    await b;
    expect(order).toEqual(['a', 'b']);
  });

  it('returns the result of the wrapped function', async () => {
    const queue = new KeyedPromiseQueue();
    const result = await queue.run('k', async () => 42);
    expect(result).toBe(42);
  });

  it('clears the lock slot once drained', async () => {
    const queue = new KeyedPromiseQueue();
    await queue.run('k', async () => {});
    expect(queue.size()).toBe(0);
  });
});
