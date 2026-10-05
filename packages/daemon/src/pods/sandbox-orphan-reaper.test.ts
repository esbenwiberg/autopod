import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxDescriptor } from '../containers/sandbox-api-client.js';
import type { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import type { PodRepository } from './pod-repository.js';
import { SandboxOrphanReaper } from './sandbox-orphan-reaper.js';

const logger = pino({ level: 'silent' });
const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function sandbox(overrides: Partial<SandboxDescriptor> & { id: string }): SandboxDescriptor {
  return {
    labels: { managedBy: 'autopod' },
    createdAt: new Date(NOW - 6 * HOUR_MS).toISOString(),
    state: 'Stopped',
    ...overrides,
  };
}

function build(
  sandboxes: SandboxDescriptor[] | undefined,
  referenced: string[] = [],
  options: { minAgeMs?: number; maxDeletesPerSweep?: number } = {},
) {
  const podRepo = {
    listReferencedContainerIds: vi.fn(() => referenced),
  } as unknown as PodRepository;
  const sandboxContainerManager = {
    listSandboxes: vi.fn(async () => sandboxes),
    kill: vi.fn(async () => {}),
  } as unknown as SandboxContainerManager;
  return {
    podRepo,
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

describe('SandboxOrphanReaper', () => {
  it('deletes autopod sandboxes that no pod row references', async () => {
    const deps = build([sandbox({ id: 'orphan-1' }), sandbox({ id: 'orphan-2' })]);
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ listed: 2, orphans: 2, deleted: 2, failed: 0 });
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledWith('orphan-1');
    expect(deps.sandboxContainerManager.kill).toHaveBeenCalledWith('orphan-2');
  });

  it('never touches sandboxes that are not labelled managedBy autopod', async () => {
    // The sandbox group is shared infrastructure — the dataverse-harness
    // sandboxes that drove the September cost spike lived in the same group.
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
    // Simulate the pod row's container_id landing between the two reads.
    const referenced: string[] = [];
    (
      deps.podRepo.listReferencedContainerIds as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => referenced);
    (
      deps.sandboxContainerManager.listSandboxes as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async () => {
      referenced.push('just-claimed');
      return [sandbox({ id: 'just-claimed' })];
    });
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ orphans: 0, deleted: 0 });
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
  });

  it('retains unreferenced sandboxes younger than the grace period', async () => {
    // A spawn holds no container_id until the disk image is pulled and the
    // sandbox reaches Running — deleting inside that window kills a live pod.
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
    (deps.sandboxContainerManager.kill as unknown as ReturnType<typeof vi.fn>)
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
      (deps.sandboxContainerManager.kill as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<void>(() => {}),
      );
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
    const result = await deps.reaper.runSweep();
    expect(result).toMatchObject({ listed: 0, orphans: 0, deleted: 0 });
    expect(deps.podRepo.listReferencedContainerIds).not.toHaveBeenCalled();
    expect(deps.sandboxContainerManager.kill).not.toHaveBeenCalled();
  });

  it('skips an overlapping sweep instead of double-deleting', async () => {
    const deps = build([sandbox({ id: 'orphan-1' })]);
    let release: (() => void) | undefined;
    (deps.sandboxContainerManager.kill as unknown as ReturnType<typeof vi.fn>).mockImplementation(
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
