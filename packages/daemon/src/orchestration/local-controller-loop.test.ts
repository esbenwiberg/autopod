import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { signalLocalRun } from '../managed/local-run-signals.js';
import { attachLocalController } from './local-controller-loop.js';

it('coalesces hints during a pass without swallowing the trailing edge or entering a transaction', async () => {
  const db = new Database(':memory:');
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0;
  const loop = attachLocalController(db, 'a', async () => {
    expect(db.inTransaction).toBe(false);
    if (++calls === 1) {
      entered.resolve();
      await release.promise;
    }
    return { blocked: [] };
  });
  try {
    await entered.promise;
    const barrier = loop.settled();
    db.transaction(() => {
      for (let i = 0; i < 30; i++) signalLocalRun(db, 'native.a');
    })();
    expect(calls).toBe(1);
    release.resolve();
    await barrier;
    expect(calls).toBe(2);
    signalLocalRun(db, 'native.aa');
    await loop.settled();
    expect(calls).toBe(2);
    await loop.close();
    signalLocalRun(db, 'native.a');
    await loop.settled();
    expect(calls).toBe(2);
  } finally {
    release.resolve();
    await loop.close();
    db.close();
  }
});
it('reports a failed pass without hot-looping and can be reattached after shutdown', async () => {
  const db = new Database(':memory:');
  let calls = 0;
  const loop = attachLocalController(db, 'a', async () => {
    calls++;
    throw new Error('blocked');
  });
  try {
    await expect(loop.settled()).rejects.toThrow('blocked');
    await expect(loop.settled()).rejects.toThrow('blocked');
    expect(calls).toBe(1);
  } finally {
    await loop.close();
  }
  const fresh = attachLocalController(db, 'a', async () => ({ blocked: [] }));
  try {
    expect(await fresh.settled()).toEqual({ blocked: [] });
  } finally {
    await fresh.close();
    db.close();
  }
});
