import type { PodStatus } from '@autopod/shared';
import type Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxDescriptor } from '../containers/sandbox-api-client.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { type PodRepository, createPodRepository } from './pod-repository.js';
import { SandboxOrphanReaper } from './sandbox-orphan-reaper.js';

const logger = pino({ level: 'silent' });
const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const databases: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function sandbox(overrides: Partial<SandboxDescriptor> & { id: string }): SandboxDescriptor {
  return {
    labels: { managedBy: 'autopod' },
    createdAt: new Date(NOW - 6 * HOUR_MS).toISOString(),
    state: 'Stopped',
    ...overrides,
  };
}

function insertOwner(repo: PodRepository, id: string, status: PodStatus = 'running') {
  repo.insert({
    id,
    profileName: 'test-profile',
    task: 'Orphan reaper fixture',
    status,
    model: 'model',
    runtime: 'codex',
    executionTarget: 'sandbox',
    branch: id,
    userId: 'user',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
}

function build(
  sandboxes: SandboxDescriptor[] | undefined,
  referenced: string[] = [],
  options: { minAgeMs?: number; maxDeletesPerSweep?: number } = {},
) {
  const db = createTestDb();
  databases.push(db);
  insertTestProfile(db);
  const podRepo = createPodRepository(db);
  const taskExecutions = podRepo.taskExecutions;
  if (!taskExecutions) throw new Error('Missing task execution ledger');
  for (const containerId of referenced) {
    insertOwner(podRepo, containerId);
    podRepo.update(containerId, { containerId });
  }
  const sandboxContainerManager = {
    listSandboxes: vi.fn(async () => sandboxes),
    kill: vi.fn(async (_id: string) => {}),
  };
  return {
    podRepo,
    taskExecutions,
    sandboxContainerManager,
    reaper: new SandboxOrphanReaper({
      podRepo,
      sandboxContainerManager,
      logger,
      now: () => NOW,
      ...options,
    }),
  };
}

function beginUnsettledRun(repo: PodRepository, id: string) {
  const ledger = repo.taskExecutions;
  if (!ledger) throw new Error('Missing task execution ledger');
  const run = ledger.beginRun(id, repo.getOrThrow(id).lifecycleGeneration, 1, {
    runtime: 'codex',
    model: 'model',
    providerAccountId: 'account',
  });
  ledger.retainUnverifiedRun(run);
}

describe('SandboxOrphanReaper', () => {
  it('deletes autopod sandboxes that no pod row references', async () => {
    const deps = build([sandbox({ id: 'orphan-1' }), sandbox({ id: 'orphan-2' })]);
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ listed: 2, orphans: 2, deleted: 2, failed: 0 });
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledWith('orphan-1');
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledWith('orphan-2');
  });

  it('deletes an old labelled orphan when its pod no longer exists', async () => {
    const deps = build([
      sandbox({ id: 'orphan', labels: { managedBy: 'autopod', podId: 'missing-owner' } }),
    ]);
    await expect(deps.reaper.runSweep()).resolves.toMatchObject({ orphans: 1, deleted: 1 });
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledExactlyOnceWith('orphan');
  });

  it.each(['failed', 'review_required'] as const)(
    'retains possible source for a %s owner after container_id was cleared',
    async (status) => {
      const deps = build([
        sandbox({ id: 'old-original', labels: { managedBy: 'autopod', podId: 'owner' } }),
      ]);
      insertOwner(deps.podRepo, 'owner', status);
      expect(deps.podRepo.getOrThrow('owner').containerId).toBeNull();
      await expect(deps.reaper.runSweep()).resolves.toMatchObject({ orphans: 0, deleted: 0 });
      expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
    },
  );

  it('retains a labelled owner with an unsettled original execution', async () => {
    const deps = build([
      sandbox({ id: 'old-original', labels: { managedBy: 'autopod', podId: 'owner' } }),
    ]);
    insertOwner(deps.podRepo, 'owner');
    beginUnsettledRun(deps.podRepo, 'owner');
    expect(deps.taskExecutions.hasActiveRun('owner')).toBe(true);
    await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
  });

  it('does not treat a label alone as a recovery claim', async () => {
    const deps = build([
      sandbox({ id: 'orphan', labels: { managedBy: 'autopod', podId: 'owner' } }),
    ]);
    insertOwner(deps.podRepo, 'owner', 'complete');
    await expect(deps.reaper.runSweep()).resolves.toMatchObject({ orphans: 1, deleted: 1 });
  });

  it('rechecks container claims after an earlier asynchronous deletion', async () => {
    const deps = build([sandbox({ id: 'first' }), sandbox({ id: 'later-claimed' })]);
    deps.sandboxContainerManager.kill.mockImplementationOnce(async () => {
      insertOwner(deps.podRepo, 'owner');
      deps.podRepo.update('owner', { containerId: 'later-claimed' });
    });
    const result = await deps.reaper.runSweep();
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledExactlyOnceWith('first');
    expect(result.deferred).toBe(1);
  });

  it.each(['failed', 'review_required', 'unsettled'] as const)(
    'rechecks a %s recovery owner after an earlier asynchronous deletion',
    async (claim) => {
      const deps = build([
        sandbox({ id: 'first' }),
        sandbox({ id: 'later-claimed', labels: { managedBy: 'autopod', podId: 'owner' } }),
      ]);
      deps.sandboxContainerManager.kill.mockImplementationOnce(async () => {
        insertOwner(deps.podRepo, 'owner', claim === 'unsettled' ? 'running' : claim);
        if (claim === 'unsettled') beginUnsettledRun(deps.podRepo, 'owner');
      });
      await expect(deps.reaper.runSweep()).resolves.toMatchObject({ deleted: 1, deferred: 1 });
      expect(deps.sandboxContainerManager.kill).toHaveBeenCalledExactlyOnceWith('first');
    },
  );

  it('fails closed on unexpected owner lookup errors and allows a later sweep', async () => {
    const deps = build([
      sandbox({ id: 'orphan', labels: { managedBy: 'autopod', podId: 'owner' } }),
    ]);
    const error = new Error('database unavailable');
    vi.spyOn(deps.podRepo, 'getOrThrow').mockImplementationOnce(() => {
      throw error;
    });
    await expect(deps.reaper.runSweep()).rejects.toBe(error);
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
    await expect(deps.reaper.runSweep()).resolves.toMatchObject({ deleted: 1 });
  });

  it('fails closed if owner lookup fails during the final deletion recheck', async () => {
    const deps = build([
      sandbox({ id: 'first' }),
      sandbox({ id: 'later', labels: { managedBy: 'autopod', podId: 'owner' } }),
    ]);
    const error = new Error('database unavailable');
    deps.sandboxContainerManager.kill.mockImplementationOnce(async () => {
      vi.spyOn(deps.podRepo, 'getOrThrow').mockImplementation(() => {
        throw error;
      });
    });
    await expect(deps.reaper.runSweep()).rejects.toBe(error);
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledExactlyOnceWith('first');
  });

  it('never touches sandboxes that are not labelled managedBy autopod', async () => {
    const deps = build([
      sandbox({ id: 'harness-1', labels: { phase5Role: 'broker', expiry: '2026-08-25' } }),
      sandbox({ id: 'harness-2', labels: {} }),
    ]);
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ listed: 2, foreign: 2, orphans: 0, deleted: 0 });
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
  });

  it('leaves sandboxes a pod row still references, whatever its status', async () => {
    const deps = build(
      [sandbox({ id: 'claimed', labels: { managedBy: 'autopod', podId: 'p1' } })],
      ['claimed'],
    );
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ orphans: 0, deleted: 0 });
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
  });

  it('reads the claim set after listing so a concurrent spawn cannot be reaped', async () => {
    const deps = build([sandbox({ id: 'just-claimed' })]);
    deps.sandboxContainerManager.listSandboxes.mockImplementation(async () => {
      insertOwner(deps.podRepo, 'owner');
      deps.podRepo.update('owner', { containerId: 'just-claimed' });
      return [sandbox({ id: 'just-claimed' })];
    });
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ orphans: 0, deleted: 0 });
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
  });

  it('retains unreferenced sandboxes younger than the grace period', async () => {
    const deps = build([
      sandbox({ id: 'provisioning', createdAt: new Date(NOW - 5 * 60 * 1000).toISOString() }),
    ]);
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ tooYoung: 1, orphans: 0, deleted: 0 });
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
  });

  it('fails closed on an unusable or future creation timestamp', async () => {
    const deps = build([
      sandbox({ id: 'no-timestamp', createdAt: undefined }),
      sandbox({ id: 'garbage-timestamp', createdAt: 'not-a-date' }),
      sandbox({ id: 'future-timestamp', createdAt: new Date(NOW + HOUR_MS).toISOString() }),
    ]);
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ ageUnknown: 3, orphans: 0, deleted: 0 });
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
  });

  it('caps deletes per sweep and defers the rest', async () => {
    const deps = build(
      Array.from({ length: 5 }, (_, i) => sandbox({ id: `orphan-${i}` })),
      [],
      { maxDeletesPerSweep: 2 },
    );
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ orphans: 5, deleted: 2, deferred: 3 });
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledTimes(2);
  });

  it('counts a failed delete without aborting the rest of the sweep', async () => {
    const deps = build([sandbox({ id: 'boom' }), sandbox({ id: 'fine' })]);
    deps.sandboxContainerManager.kill
      .mockRejectedValueOnce(new Error('InternalError: preserving Global metadata'))
      .mockResolvedValueOnce(undefined);
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ orphans: 2, deleted: 1, failed: 1 });
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledTimes(2);
  });

  it('treats a delete that outruns its deadline as a retryable failure', async () => {
    vi.useFakeTimers();
    try {
      const deps = build([sandbox({ id: 'hangs' })]);
      deps.sandboxContainerManager.kill.mockImplementation(() => new Promise<void>(() => {}));
      const reaper = new SandboxOrphanReaper({
        podRepo: deps.podRepo,
        sandboxContainerManager: deps.sandboxContainerManager,
        logger,
        now: () => NOW,
        deletionTimeoutMs: 1_000,
      });
      const sweep = reaper.runSweep();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await sweep).toMatchObject({ orphans: 1, deleted: 0, failed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables itself when the client cannot list sandboxes', async () => {
    const deps = build(undefined);
    const references = vi.spyOn(deps.podRepo, 'listReferencedContainerIds');
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ listed: 0, orphans: 0, deleted: 0 });
    expect(references).not.toHaveBeenCalled();
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
  });

  it('skips an overlapping sweep instead of double-deleting', async () => {
    const deps = build([sandbox({ id: 'orphan-1' })]);
    let release: (() => void) | undefined;
    deps.sandboxContainerManager.kill.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = deps.reaper.runSweep();
    const second = await deps.reaper.runSweep();
    expect(second).toMatchObject({ listed: 0, deleted: 0 });
    release?.();
    await first;
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledTimes(1);
  });
});
