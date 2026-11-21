import { DefaultAzureCredential } from '@azure/identity';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';
import { type ComputeObservation, createSandboxComputeCost } from './sandbox-compute-cost.js';

const sample: ComputeObservation = {
  resourceKey: 'group/A',
  sandboxId: 'A',
  podId: 'owner',
  region: 'northeurope',
  at: 0,
  state: 'running',
  cpu: 2,
  gib: 4,
};
describe('sandbox compute observations', () => {
  it('samples only tracked resources and observes auto-suspend, indirect resume and restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T00:00:00Z'));
    const db = createTestDb();
    insertTestProfile(db);
    const profileName = 'test-profile';
    const repo = createPodRepository(db);
    repo.insert({
      id: 'owner',
      profileName,
      task: 'Compute fixture',
      status: 'running',
      model: 'test',
      runtime: 'claude',
      executionTarget: 'sandbox',
      branch: 'fixture',
      userId: 'tester',
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
    });
    repo.update('owner', { containerId: 'A' });
    let state = 'Running';
    let identity = 'A';
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: identity,
            state,
            labels: { managedBy: 'autopod', podId: 'owner' },
            resources: { cpu: '2', memory: '4Gi' },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(DefaultAzureCredential.prototype, 'getToken').mockResolvedValue({
      token: 'fixture-token',
      expiresOnTimestamp: Date.now() + 3600000,
    });
    const config = { subscriptionId: 'fixture', resourceGroup: 'fixture', location: 'northeurope' };
    let manager = SandboxContainerManager.withAzureClient(config, pino({ level: 'silent' }), {
      managedDatabase: db,
    });
    const costs = createSandboxComputeCost(db);
    try {
      expect(fetch).not.toHaveBeenCalled();
      await manager.getStatus('A');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(costs.get('owner').estimateUsd).toBeCloseTo(0.0018);
      state = 'Stopped';
      await vi.advanceTimersByTimeAsync(60_000);
      expect(costs.get('owner').estimateUsd).toBeCloseTo(0.0027);
      state = 'Running'; // Provider-side resume: no daemon lifecycle mutation.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(costs.get('owner').estimateUsd).toBeCloseTo(0.0036);
      manager.stopComputeObservations();
      vi.setSystemTime(Date.now() + 10_000);
      manager = SandboxContainerManager.withAzureClient(config, pino({ level: 'silent' }), {
        managedDatabase: db,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(costs.get('owner').estimateUsd).toBeCloseTo(0.0036);
      identity = 'different-allocation';
      await vi.advanceTimersByTimeAsync(30_000);
      identity = 'A';
      await vi.advanceTimersByTimeAsync(30_000);
      expect(costs.get('owner').estimateUsd).toBeCloseTo(0.0036);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(costs.get('owner').estimateUsd).toBeCloseTo(0.0054);
      expect(fetch.mock.calls.every((call) => String(call[0]).includes('/sandboxes/A'))).toBe(true);
    } finally {
      manager.stopComputeObservations();
      db.close();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
  it('keeps stopped-first history unavailable until running compute is observed', () => {
    const db = createTestDb();
    try {
      const store = createSandboxComputeCost(db);
      const at = Date.now() - 120_000;
      store.observe({ ...sample, at, state: 'stopped' });
      store.observe({ ...sample, at: at + 30_000, state: 'stopped' });
      expect(store.get('owner')).toMatchObject({ state: 'unavailable', estimateUsd: null });
      expect(createSandboxComputeCost(db).get('owner')).toMatchObject({
        state: 'unavailable',
        estimateUsd: null,
      });

      store.observe({ ...sample, at: at + 60_000 });
      expect(store.get('owner').state).toBe('partial');
      expect(store.get('owner').estimateUsd).toBeCloseTo(0.0009, 12);
      store.observe({ ...sample, at: at + 90_000 });
      store.observe({ ...sample, at: at + 120_000, state: 'terminal', cpu: null, gib: null });
      const settled = createSandboxComputeCost(db).get('owner');
      expect(settled.state).toBe('partial');
      expect(settled.estimateUsd).toBeCloseTo(0.0036, 12);
    } finally {
      db.close();
    }
  });

  it('prices 300 observed running seconds at 2 vCPU / 4 GiB as $0.018', () => {
    const db = createTestDb();
    const store = createSandboxComputeCost(db);
    for (let at = 0; at <= 300_000; at += 30_000) store.observe({ ...sample, at });
    expect(store.get('owner').estimateUsd).toBeCloseTo(0.018, 12);
    store.observe({ ...sample, at: 300_000 });
    store.observe({ ...sample, at: 150_000 });
    expect(store.get('owner').estimateUsd).toBeCloseTo(0.018, 12);
    store.observe({ ...sample, at: 330_000, state: 'stopped' });
    const stopped = store.get('owner').estimateUsd;
    store.observe({ ...sample, at: 360_000, state: 'stopped' });
    expect(store.get('owner').estimateUsd).toBe(stopped);
    store.observe({ ...sample, at: 390_000 });
    store.observe({ ...sample, at: 420_000 });
    expect(store.get('owner').estimateUsd).toBeCloseTo(0.0216, 12);
    db.close();
  });
  it('retains replacement totals and excludes gaps, unknowns, replay and ownership races', () => {
    const db = createTestDb();
    let store = createSandboxComputeCost(db);
    store.observe(sample);
    store.observe({ ...sample, at: 30_000 });
    store = createSandboxComputeCost(db);
    store.observe({ ...sample, at: 180_000 });
    store.observe({ ...sample, at: 210_000, state: 'unknown' });
    store.observe({ ...sample, at: 240_000 });
    store.observe({ ...sample, at: 270_000, podId: 'other' });
    expect(store.get('owner').estimateUsd).toBeCloseTo(0.0018);
    for (const at of [0, 30_000])
      store.observe({ ...sample, resourceKey: 'group/B', sandboxId: 'B', at });
    expect(store.get('owner').estimateUsd).toBeCloseTo(0.0036);
    expect(store.get('owner').state).toBe('partial');
    expect(store.get('other').estimateUsd).toBeNull();
    // A delete request produces no observation. Only provider confirmation can settle it.
    expect(store.tracked()).toHaveLength(2);
    store.observe({ ...sample, at: 270_000, state: 'terminal', cpu: null, gib: null });
    expect(store.tracked()).toHaveLength(1);
    const settled = createSandboxComputeCost(db).get('owner').estimateUsd;
    expect(settled).toBeGreaterThan(0);
    store.observe({ ...sample, at: 300_000 });
    store.observe({ ...sample, at: 330_000 });
    expect(store.get('owner').estimateUsd).toBe(settled);
    db.close();
  });
  it('pins retail provenance and excludes changed allocation and short restart gaps', () => {
    const db = createTestDb();
    const store = createSandboxComputeCost(db);
    store.observe(sample);
    store.observe({ ...sample, at: 30_000 });
    // Startup's durable unknown boundary prevents bridging even a short restart.
    store.observe({ ...sample, at: 40_000, state: 'unknown' });
    store.observe({ ...sample, at: 50_000 });
    store.observe({ ...sample, at: 60_000, cpu: 4 });
    expect(store.get('owner').estimateUsd).toBeCloseTo(0.0018);
    store.observe({ ...sample, at: 90_000, cpu: 4 });
    expect(store.get('owner').estimateUsd).toBeCloseTo(0.00504);
    const row = db.prepare('SELECT evidence FROM sandbox_compute_cost').get() as {
      evidence: string;
    };
    const buckets = Object.values(JSON.parse(row.evidence).prices);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      seconds: 30,
      cpuMeter: '4ebd2e58-3f2c-58a5-a442-8460e472dce7',
      memoryMeter: 'c43d1f5d-5a92-5222-80a3-228227a1ddd8',
      effective: '2022-06-01',
      retrieved: '2026-11-21',
      cpuUsd: 0.000024,
      gibUsd: 0.000003,
      currency: 'USD',
      sku: 'Standard',
    });
    db.close();
  });
  it('keeps unknown regions and allocations unavailable rather than zero', () => {
    const db = createTestDb();
    const store = createSandboxComputeCost(db);
    for (const at of [0, 30_000]) store.observe({ ...sample, at, region: 'unknown' });
    expect(store.get('owner')).toMatchObject({ state: 'unavailable', estimateUsd: null });
    for (const at of [0, 30_000])
      store.observe({ ...sample, podId: 'missing', resourceKey: 'group/C', at, cpu: null });
    expect(store.get('missing').estimateUsd).toBeNull();
    db.close();
  });
  it('breaks continuity on conflicting or failed observations at the same timestamp', () => {
    const db = createTestDb();
    const store = createSandboxComputeCost(db);
    store.observe(sample);
    store.observe({ ...sample, at: 30_000 });
    store.observe({ ...sample, at: 30_000, state: 'unknown' });
    store.observe({ ...sample, at: 60_000 });
    expect(store.get('owner').estimateUsd).toBeCloseTo(0.0018);
    db.close();
  });
});
