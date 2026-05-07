import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import type { NewPod } from './pod-repository.js';
import { ScreenshotRetention } from './screenshot-retention.js';
import type { ScreenshotStore } from './screenshot-store.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockStore(
  deleteFn?: (podId: string) => Promise<void>,
): ScreenshotStore & { delete: ReturnType<typeof vi.fn> } {
  const deleteMock = deleteFn
    ? vi.fn(deleteFn)
    : vi.fn<[string], Promise<void>>().mockResolvedValue(undefined);
  return {
    write: vi.fn(),
    read: vi.fn(),
    list: vi.fn(),
    delete: deleteMock,
  };
}

const BASE_POD: Omit<NewPod, 'id'> = {
  profileName: 'test-profile',
  task: 'test task',
  status: 'queued',
  model: 'claude-3-opus',
  runtime: 'claude',
  executionTarget: 'local',
  branch: 'autopod/abc12345',
  userId: 'user-1',
  maxValidationAttempts: 3,
  skipValidation: false,
  outputMode: 'pr',
};

/** Returns an ISO timestamp N days ago relative to Date.now(). */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ScreenshotRetention.sweepOnce', () => {
  let db: ReturnType<typeof createTestDb>;
  let podRepo: ReturnType<typeof createPodRepository>;

  beforeEach(() => {
    db = createTestDb();
    insertTestProfile(db);
    podRepo = createPodRepository(db);
  });

  it('empty cohort — no terminal pods — returns {scanned:0, deleted:0} and never calls delete', async () => {
    const store = makeMockStore();
    const retention = new ScreenshotRetention({
      retentionDays: 30,
      sweepIntervalMs: 60_000,
      podRepository: podRepo,
      screenshotStore: store,
      logger,
    });

    const result = await retention.sweepOnce();

    expect(result).toEqual({ scanned: 0, deleted: 0 });
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('fresh terminal pod — completed 5 days ago with retentionDays:30 — NOT swept', async () => {
    const store = makeMockStore();
    podRepo.insert({ ...BASE_POD, id: 'freshpod', status: 'complete' });
    podRepo.update('freshpod', { completedAt: daysAgoIso(5) });

    const retention = new ScreenshotRetention({
      retentionDays: 30,
      sweepIntervalMs: 60_000,
      podRepository: podRepo,
      screenshotStore: store,
      logger,
    });

    const result = await retention.sweepOnce();

    expect(result).toEqual({ scanned: 0, deleted: 0 });
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('stale terminal pod — completed 31 days ago — swept; delete called once', async () => {
    const store = makeMockStore();
    podRepo.insert({ ...BASE_POD, id: 'stalepod', status: 'complete' });
    podRepo.update('stalepod', { completedAt: daysAgoIso(31) });

    const retention = new ScreenshotRetention({
      retentionDays: 30,
      sweepIntervalMs: 60_000,
      podRepository: podRepo,
      screenshotStore: store,
      logger,
    });

    const result = await retention.sweepOnce();

    expect(result).toEqual({ scanned: 1, deleted: 1 });
    expect(store.delete).toHaveBeenCalledOnce();
    expect(store.delete).toHaveBeenCalledWith('stalepod');
  });

  it('mixed cohort — only stale terminal pod is swept; fresh and non-terminal are skipped', async () => {
    const store = makeMockStore();

    // Fresh terminal pod (5 days old) — NOT swept
    podRepo.insert({ ...BASE_POD, id: 'freshpod', status: 'complete' });
    podRepo.update('freshpod', { completedAt: daysAgoIso(5) });

    // Stale terminal pod (31 days old) — SWEPT
    podRepo.insert({ ...BASE_POD, id: 'stalepod', status: 'killed' });
    podRepo.update('stalepod', { completedAt: daysAgoIso(31) });

    // Non-terminal pod that is old (running) — NOT swept (no completed_at, wrong status)
    podRepo.insert({ ...BASE_POD, id: 'runningpd', status: 'running' });

    const retention = new ScreenshotRetention({
      retentionDays: 30,
      sweepIntervalMs: 60_000,
      podRepository: podRepo,
      screenshotStore: store,
      logger,
    });

    const result = await retention.sweepOnce();

    expect(result).toEqual({ scanned: 1, deleted: 1 });
    expect(store.delete).toHaveBeenCalledOnce();
    expect(store.delete).toHaveBeenCalledWith('stalepod');
  });

  it('idempotency — sweepOnce called twice on same stale pod — delete called twice (store contract handles it)', async () => {
    const store = makeMockStore();
    podRepo.insert({ ...BASE_POD, id: 'stalepod', status: 'complete' });
    podRepo.update('stalepod', { completedAt: daysAgoIso(31) });

    const retention = new ScreenshotRetention({
      retentionDays: 30,
      sweepIntervalMs: 60_000,
      podRepository: podRepo,
      screenshotStore: store,
      logger,
    });

    await retention.sweepOnce();
    await retention.sweepOnce();

    // The sweeper does NOT track per-pod state — it queries the repository each
    // time. The store's delete is idempotent; the sweeper just calls it again.
    expect(store.delete).toHaveBeenCalledTimes(2);
    expect(store.delete).toHaveBeenNthCalledWith(1, 'stalepod');
    expect(store.delete).toHaveBeenNthCalledWith(2, 'stalepod');
  });

  it('delete failure isolation — three stale pods; delete throws for pod2; pods 1 and 3 still deleted', async () => {
    const logSpy = vi.spyOn(logger, 'error');

    const store = makeMockStore(async (podId: string) => {
      if (podId === 'pod00002') throw new Error('permission denied');
    });

    for (const id of ['pod00001', 'pod00002', 'pod00003']) {
      podRepo.insert({ ...BASE_POD, id, status: 'complete' });
      podRepo.update(id, { completedAt: daysAgoIso(31) });
    }

    const retention = new ScreenshotRetention({
      retentionDays: 30,
      sweepIntervalMs: 60_000,
      podRepository: podRepo,
      screenshotStore: store,
      logger,
    });

    // Must not throw even though delete fails for pod2
    const result = await retention.sweepOnce();

    expect(result).toEqual({ scanned: 3, deleted: 2 });
    expect(store.delete).toHaveBeenCalledTimes(3);
    expect(store.delete).toHaveBeenCalledWith('pod00001');
    expect(store.delete).toHaveBeenCalledWith('pod00002');
    expect(store.delete).toHaveBeenCalledWith('pod00003');
    // An error was logged for pod2
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ podId: 'pod00002' }),
      expect.stringContaining('failed to delete'),
    );
  });

  it('retention day boundary — pod completed exactly retentionDays ago — IS swept (boundary inclusive)', async () => {
    const store = makeMockStore();
    const retentionDays = 30;

    // Set completed_at to exactly retentionDays * 24h ago, rounded to the second
    // so it sits precisely at the cutoff boundary.
    const exactCutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const exactCutoffIso = new Date(exactCutoffMs).toISOString();

    podRepo.insert({ ...BASE_POD, id: 'boundaryd', status: 'complete' });
    podRepo.update('boundaryd', { completedAt: exactCutoffIso });

    const retention = new ScreenshotRetention({
      retentionDays,
      sweepIntervalMs: 60_000,
      podRepository: podRepo,
      screenshotStore: store,
      logger,
    });

    const result = await retention.sweepOnce();

    expect(result.deleted).toBe(1);
    expect(store.delete).toHaveBeenCalledWith('boundaryd');
  });

  it('workspace pods — hit terminal states; sweeper calls delete; store no-ops silently', async () => {
    const store = makeMockStore(); // delete is a no-op mock — no error

    // Workspace pods complete normally; they have no screenshots but the sweeper
    // still calls delete (idempotent store handles missing dirs without error).
    podRepo.insert({ ...BASE_POD, id: 'wkspace1', status: 'complete' });
    podRepo.update('wkspace1', { completedAt: daysAgoIso(31) });

    const retention = new ScreenshotRetention({
      retentionDays: 30,
      sweepIntervalMs: 60_000,
      podRepository: podRepo,
      screenshotStore: store,
      logger,
    });

    const result = await retention.sweepOnce();

    expect(result).toEqual({ scanned: 1, deleted: 1 });
    expect(store.delete).toHaveBeenCalledWith('wkspace1');
  });

  it('failed pods — included in terminal cohort and swept', async () => {
    const store = makeMockStore();
    podRepo.insert({ ...BASE_POD, id: 'failedpd', status: 'failed' });
    podRepo.update('failedpd', { completedAt: daysAgoIso(31) });

    const retention = new ScreenshotRetention({
      retentionDays: 30,
      sweepIntervalMs: 60_000,
      podRepository: podRepo,
      screenshotStore: store,
      logger,
    });

    const result = await retention.sweepOnce();

    expect(result).toEqual({ scanned: 1, deleted: 1 });
    expect(store.delete).toHaveBeenCalledWith('failedpd');
  });
});

describe('ScreenshotRetention timer behaviour', () => {
  let db: ReturnType<typeof createTestDb>;
  let podRepo: ReturnType<typeof createPodRepository>;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    insertTestProfile(db);
    podRepo = createPodRepository(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stop() after start() cleanly cancels the next tick — no further sweeps fire', async () => {
    const store = makeMockStore();
    podRepo.insert({ ...BASE_POD, id: 'stalepod', status: 'complete' });
    // Use a timestamp stale enough relative to the fake clock's epoch (real time).
    const staleIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    podRepo.update('stalepod', { completedAt: staleIso });

    const retention = new ScreenshotRetention({
      retentionDays: 30,
      sweepIntervalMs: 50,
      podRepository: podRepo,
      screenshotStore: store,
      logger,
    });

    retention.start();
    // Flush the immediate (non-interval) sweep by advancing 0 ms and draining microtasks
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirstSweep = store.delete.mock.calls.length;

    retention.stop();

    // Advance well past several intervals — cleared timer should not fire
    await vi.advanceTimersByTimeAsync(500);

    expect(store.delete.mock.calls.length).toBe(callsAfterFirstSweep);
  });

  it('start() is idempotent — calling twice does not stack two timers', async () => {
    const store = makeMockStore();
    podRepo.insert({ ...BASE_POD, id: 'stalepod', status: 'complete' });
    const staleIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    podRepo.update('stalepod', { completedAt: staleIso });

    const retention = new ScreenshotRetention({
      retentionDays: 30,
      sweepIntervalMs: 100,
      podRepository: podRepo,
      screenshotStore: store,
      logger,
    });

    retention.start();
    retention.start(); // second call must be a no-op

    // Flush the immediate sweep
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterImmediate = store.delete.mock.calls.length;

    // Advance exactly one interval — with two stacked timers we'd see 2 firings
    await vi.advanceTimersByTimeAsync(100);

    // With a single timer, at most one more sweep fires per interval
    const callsAfterInterval = store.delete.mock.calls.length;
    expect(callsAfterInterval - callsAfterImmediate).toBeLessThanOrEqual(1);

    retention.stop();
  });
});
