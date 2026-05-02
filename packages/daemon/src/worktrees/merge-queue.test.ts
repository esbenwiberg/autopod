import { describe, expect, it } from 'vitest';
import { MergeQueue } from './merge-queue.js';

describe('MergeQueue', () => {
  describe('keyFor', () => {
    it('combines repo URL and base branch', () => {
      expect(MergeQueue.keyFor('https://github.com/o/r', 'main')).toBe(
        'https://github.com/o/r::main',
      );
    });

    it('uses a stable placeholder when repoUrl is null', () => {
      expect(MergeQueue.keyFor(null, 'main')).toBe('<no-repo>::main');
    });

    it('treats different base branches as distinct keys', () => {
      expect(MergeQueue.keyFor('repo', 'main')).not.toBe(MergeQueue.keyFor('repo', 'develop'));
    });

    it('treats different repos as distinct keys', () => {
      expect(MergeQueue.keyFor('repo-a', 'main')).not.toBe(MergeQueue.keyFor('repo-b', 'main'));
    });
  });

  describe('run', () => {
    it('serializes calls with the same key', async () => {
      const queue = new MergeQueue();
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

      // Give the event loop a chance to tick — b must NOT have started yet.
      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual(['a:start']);

      // biome-ignore lint/style/noNonNullAssertion: assigned synchronously above
      resolveA!();
      await Promise.all([a, b]);

      expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    });

    it('runs different keys concurrently', async () => {
      const queue = new MergeQueue();
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

      // b should complete while a is still blocked — different key.
      await b;
      expect(order).toEqual(['a:start', 'b:start', 'b:end']);

      // biome-ignore lint/style/noNonNullAssertion: assigned synchronously above
      resolveA!();
      await a;
      expect(order).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
    });

    it('advances the queue after a rejected task', async () => {
      const queue = new MergeQueue();
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
      const queue = new MergeQueue();
      const result = await queue.run('k', async () => 42);
      expect(result).toBe(42);
    });

    it('clears the lock slot once drained', async () => {
      const queue = new MergeQueue();
      await queue.run('k', async () => {});
      expect(queue.size()).toBe(0);
    });
  });
});
