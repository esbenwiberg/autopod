import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import { SandboxOrphanReaper } from './sandbox-orphan-reaper.js';
import { ScreenshotRetention } from './screenshot-retention.js';
import { createScreenshotStore } from './screenshot-store.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});
function fixture() {
  const db = createTestDb();
  cleanup.push(() => db.close());
  insertTestProfile(db);
  const pods = createPodRepository(db);
  function pod(id: string, status: 'complete' | 'killed' = 'killed') {
    pods.insert({
      id,
      status,
      profileName: 'test-profile',
      task: 'Retained evidence',
      model: 'model',
      runtime: 'codex',
      executionTarget: 'sandbox',
      branch: id,
      userId: 'human',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
    pods.update(id, { completedAt: new Date(Date.now() - 40 * 86400_000).toISOString() });
  }
  // Seed an authorized, finalized hold; these tests exercise retention, not controller admission.
  function hold(id: string) {
    const ledger = pods.retainedFinalizations;
    if (!ledger || !pods.taskExecutions || !pods.atomically)
      throw new Error('Managed fixture required');
    const current = pods.getOrThrow(id);
    const binding = 'a'.repeat(64);
    ledger.admit(
      {
        fingerprint: binding,
        generation: current.lifecycleGeneration,
        containerId: null,
        target: 'sandbox',
        worktreePath: null,
        resources: [],
        taskId: pods.taskExecutions.snapshot(id).taskId,
        owners: [{ kind: 'continuation', id: `owner-${id}` }],
        sourceLocations: [],
      },
      {
        podId: id,
        request: {
          requestKey: `finalize-${id}`,
          expectedGeneration: current.lifecycleGeneration,
          expectedBinding: binding,
          mode: current.status === 'complete' ? 'complete-merged' : 'stop-retain',
          reason: 'Preserve all retained source and evidence',
        },
        actor: { type: 'human', userId: 'human' },
        state: 'pending',
        createdAt: new Date().toISOString(),
        finalizedAt: null,
        message: 'Retained',
        resourcesRetained: true,
      },
      `hash-${id}`,
      null,
    );
    pods.atomically(() => ledger.terminal(id, () => ledger.finish(id, null)));
  }
  return { db, pods, pod, hold };
}
function descriptor(id: string, podId: string) {
  return {
    id,
    labels: { managedBy: 'autopod', podId },
    state: 'Stopped',
    createdAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
  };
}

describe('finalization keeps otherwise unreferenced evidence', () => {
  it.each(['complete', 'killed'] as const)(
    'retains unrecorded pod-labelled sandbox after %s',
    async (status) => {
      const f = fixture();
      f.pod('held', status);
      f.hold('held');
      f.pod('ordinary', status);
      const manager = {
        listSandboxes: vi.fn(async () => [
          descriptor('lost-spawn-response', 'held'),
          descriptor('ordinary-orphan', 'ordinary'),
        ]),
        kill: vi.fn(async () => {}),
      };
      expect(f.pods.listReferencedContainerIds()).not.toContain('lost-spawn-response');
      const reaper = new SandboxOrphanReaper({
        podRepo: f.pods,
        sandboxContainerManager: manager,
        logger,
      });
      await expect(reaper.runSweep()).resolves.toMatchObject({ deleted: 1 });
      expect(manager.kill).toHaveBeenCalledExactlyOnceWith('ordinary-orphan');
    },
  );

  it('rechecks finalization custody after an earlier orphan deletion awaits', async () => {
    const f = fixture();
    f.pod('first');
    f.pod('later');
    const manager = {
      listSandboxes: vi.fn(async () => [
        descriptor('first-orphan', 'first'),
        descriptor('late-orphan', 'later'),
      ]),
      kill: vi.fn(async () => {
        f.hold('later');
      }),
    };
    const reaper = new SandboxOrphanReaper({
      podRepo: f.pods,
      sandboxContainerManager: manager,
      logger,
    });
    await expect(reaper.runSweep()).resolves.toMatchObject({ deleted: 1, deferred: 1 });
    expect(manager.kill).toHaveBeenCalledExactlyOnceWith('first-orphan');
  });

  it('refuses direct screenshot deletion and overwrite while keeping reads available', async () => {
    const f = fixture();
    f.pod('held');
    const folder = await mkdtemp(path.join(os.tmpdir(), 'retained-store-'));
    cleanup.push(() => rm(folder, { recursive: true, force: true }));
    const store = createScreenshotStore(folder, (id) =>
      f.pods.retainedFinalizations?.assertAvailable(id),
    );
    const bytes = Buffer.from('retained review evidence');
    const ref = await store.write('held', 'review', 'proof.png', bytes);
    f.hold('held');
    await expect(store.delete('held')).rejects.toMatchObject({
      code: 'RETAINED_FINALIZATION_BLOCKED',
    });
    await expect(
      store.write('held', 'review', 'proof.png', Buffer.from('replacement')),
    ).rejects.toMatchObject({ code: 'RETAINED_FINALIZATION_BLOCKED' });
    expect(await store.read(ref)).toEqual(bytes);
    const other = await store.write('ordinary', 'review', 'proof.png', bytes);
    expect(await store.read(other)).toEqual(bytes);
    await store.delete('ordinary');
    expect(await store.list('ordinary')).toEqual([]);
  });

  it('rechecks screenshot custody after an earlier deletion awaits', async () => {
    const f = fixture();
    f.pod('first');
    f.pod('later');
    const folder = await mkdtemp(path.join(os.tmpdir(), 'retained-sweep-'));
    cleanup.push(() => rm(folder, { recursive: true, force: true }));
    const store = createScreenshotStore(folder);
    const ref = await store.write('later', 'review', 'proof.png', Buffer.from('later evidence'));
    const remove = store.delete;
    vi.spyOn(store, 'delete').mockImplementation(async (id) => {
      if (id === 'first') f.hold('later');
      await remove(id);
    });
    const sweeper = new ScreenshotRetention({
      retentionDays: 30,
      sweepIntervalMs: 60_000,
      podRepository: f.pods,
      screenshotStore: store,
      logger,
    });
    expect((await sweeper.sweepOnce()).deleted).toBe(1);
    expect(store.delete).toHaveBeenCalledExactlyOnceWith('first');
    expect(await store.read(ref)).toEqual(Buffer.from('later evidence'));
  });

  it.each([false, true])(
    'retains screenshot bytes with stale candidate list=%s',
    async (staleList) => {
      const f = fixture();
      f.pod('held');
      f.pod('ordinary', 'complete');
      const folder = await mkdtemp(path.join(os.tmpdir(), 'retained-screenshots-'));
      cleanup.push(() => rm(folder, { recursive: true, force: true }));
      const store = createScreenshotStore(folder);
      const bytes = Buffer.from('independent validation screenshot evidence');
      const ref = await store.write('held', 'review', 'retained.png', bytes);
      await store.write('ordinary', 'review', 'ordinary.png', bytes);
      const candidates = f.pods.listTerminalPodsCompletedBefore(new Date().toISOString());
      f.hold('held');
      if (staleList)
        vi.spyOn(f.pods, 'listTerminalPodsCompletedBefore').mockReturnValue(candidates);
      else
        expect(
          f.pods.listTerminalPodsCompletedBefore(new Date().toISOString()).map((p) => p.id),
        ).toEqual(['ordinary']);
      const sweeper = new ScreenshotRetention({
        retentionDays: 30,
        sweepIntervalMs: 60_000,
        podRepository: f.pods,
        screenshotStore: store,
        logger,
      });
      expect((await sweeper.sweepOnce()).deleted).toBe(1);
      expect(await store.read(ref)).toEqual(bytes);
      expect(await store.list('ordinary')).toEqual([]);
    },
  );
});
