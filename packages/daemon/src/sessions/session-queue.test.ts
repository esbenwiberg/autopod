import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createSessionQueue } from './session-queue.js';

const logger = pino({ level: 'silent' });

describe('session-queue', () => {
  it('processes enqueued sessions', async () => {
    const processed: string[] = [];
    const processor = vi.fn(async (id: string) => {
      processed.push(id);
    });

    const queue = createSessionQueue(2, processor, logger);
    queue.enqueue('s1');
    queue.enqueue('s2');

    await queue.drain();
    expect(processed).toEqual(['s1', 's2']);
    expect(processor).toHaveBeenCalledTimes(2);
  });

  it('respects max concurrency', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const processor = vi.fn(async (_id: string) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      currentConcurrent--;
    });

    const queue = createSessionQueue(2, processor, logger);
    queue.enqueue('s1');
    queue.enqueue('s2');
    queue.enqueue('s3');
    queue.enqueue('s4');

    await queue.drain();
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(processor).toHaveBeenCalledTimes(4);
  });

  it('reports pending and processing counts', async () => {
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const processor = vi.fn(async (_id: string) => {
      await firstPromise;
    });

    const queue = createSessionQueue(1, processor, logger);

    expect(queue.pending).toBe(0);
    expect(queue.processing).toBe(0);

    queue.enqueue('s1');
    queue.enqueue('s2');

    // s1 is processing, s2 is pending
    expect(queue.processing).toBe(1);
    expect(queue.pending).toBe(1);

    resolveFirst();
    await queue.drain();

    expect(queue.pending).toBe(0);
    expect(queue.processing).toBe(0);
  });

  it('drain resolves immediately if queue is empty', async () => {
    const processor = vi.fn(async () => {});
    const queue = createSessionQueue(2, processor, logger);

    // Should resolve immediately without hanging
    await queue.drain();
  });

  it('handles processor errors without breaking the queue', async () => {
    const processed: string[] = [];
    const processor = vi.fn(async (id: string) => {
      if (id === 's1') throw new Error('boom');
      processed.push(id);
    });

    const queue = createSessionQueue(1, processor, logger);
    queue.enqueue('s1');
    queue.enqueue('s2');

    await queue.drain();
    expect(processed).toEqual(['s2']);
    expect(processor).toHaveBeenCalledTimes(2);
  });

  it('processes items in FIFO order', async () => {
    const processed: string[] = [];
    const processor = vi.fn(async (id: string) => {
      processed.push(id);
    });

    const queue = createSessionQueue(1, processor, logger);
    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('c');

    await queue.drain();
    expect(processed).toEqual(['a', 'b', 'c']);
  });
});
