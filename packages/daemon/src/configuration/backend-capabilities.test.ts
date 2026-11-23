import type Dockerode from 'dockerode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDockerHostCapacityProbe,
  DOCKER_CAPACITY_FRESH_MS,
  DOCKER_CAPACITY_PROBE_MEMO_MS,
  DOCKER_CAPACITY_PROBE_TIMEOUT_MS,
  dockerCapabilities,
  sandboxCapabilities,
} from './backend-capabilities.js';

describe('reported backend capabilities', () => {
  it('reports every offered sandbox bundle up to 3XL, keeping the L default separate from the maximum', () => {
    const caps = sandboxCapabilities({ enabled: true, defaultTier: 'L' });
    expect(caps.memoryTiersGb).toEqual([0.5, 1, 2, 4, 8, 16, 32]);
    expect(caps.defaults.memoryGb).toBe(4);
    expect(caps.maxMemoryGb).toBe(32);
    expect(caps.maxTotalMemoryGb).toBe(32);
    expect(caps.defaults.cpus).toBeNull();
    expect(caps.defaults.storageGb).toBeNull();
    expect(caps.maxStorageGb).toBeNull();
    expect(sandboxCapabilities({ enabled: true, defaultTier: 'M' }).defaults.memoryGb).toBe(2);
    expect(caps.memoryBundles?.map((bundle) => bundle.memoryGb)).toEqual(caps.memoryTiersGb);
    expect(caps.memoryBundles?.slice(-3)).toEqual([
      {
        tier: 'XL',
        memoryGb: 8,
        cpus: 4,
        diskGb: 80,
        label: 'XL · 4 vCPU · 8 GiB RAM · 80 GiB disk',
      },
      {
        tier: '2XL',
        memoryGb: 16,
        cpus: 8,
        diskGb: 160,
        label: '2XL · 8 vCPU · 16 GiB RAM · 160 GiB disk',
      },
      {
        tier: '3XL',
        memoryGb: 32,
        cpus: 16,
        diskGb: 320,
        label: '3XL · 16 vCPU · 32 GiB RAM · 320 GiB disk',
      },
    ]);
    expect(caps.sidecars).toBe(false);
    expect(caps.maxCpus).toBeNull();
    expect(sandboxCapabilities({ enabled: false, defaultTier: 'M' }).available).toBe(false);
  });
  it('bounds Docker allocations by both actual capacity and operator limits', async () => {
    const info = async () => ({ MemTotal: 8 * 1024 ** 3, NCPU: 4 });
    const caps = await dockerCapabilities({
      probe: createDockerHostCapacityProbe({
        docker: { info } as unknown as Pick<Dockerode, 'info'>,
      }),
      privilegedSidecars: false,
      limits: { memoryGb: 16, cpus: 2 },
      defaults: { memoryGb: 2, cpus: 1 },
    });
    expect(caps.maxMemoryGb).toBe(8);
    expect(caps.maxCpus).toBe(2);
    expect(caps.privilegedSidecars).toBe(false);
    expect(caps.maxStorageGb).toBeNull();
    expect(caps.sidecarStorageLimit).toBe(false);
    expect(caps.memoryBundles).toBeNull();
    expect(caps.hostCapacity).toMatchObject({ state: 'live', observedAt: expect.any(String) });
    expect(caps.hostCapacity?.reason).toBeUndefined();
  });
  it('reports a daemon without a Docker client as permanently unavailable', async () => {
    const offline = await dockerCapabilities({
      probe: null,
      privilegedSidecars: false,
      limits: { memoryGb: 16, cpus: 2 },
      defaults: { memoryGb: 2, cpus: 1 },
    });
    expect(offline.available).toBe(false);
    expect(offline.unavailableReason).toBe('Docker is not configured on this daemon');
    expect(offline.hostCapacity).toBeUndefined();
  });
  it('keeps a default above the host size a permanent refusal', async () => {
    const caps = await dockerCapabilities({
      probe: createDockerHostCapacityProbe({
        docker: { info: async () => ({ MemTotal: 2 * 1024 ** 3, NCPU: 4 }) },
      }),
      privilegedSidecars: false,
      limits: { memoryGb: 16, cpus: 8 },
      defaults: { memoryGb: 4, cpus: 1 },
    });
    expect(caps.available).toBe(false);
    expect(caps.unavailableReason).toContain('Configured default allocation exceeds');
  });
});

describe('Docker host capacity probe (#665)', () => {
  const host = { MemTotal: 8 * 1024 ** 3, NCPU: 4 };
  const settings = {
    privilegedSidecars: false,
    limits: { memoryGb: 128, cpus: 128 },
    defaults: { memoryGb: 2, cpus: 1 },
  };
  afterEach(() => vi.useRealTimers());

  it('treats a timed-out check without any report as transient, admitting within operator limits', async () => {
    vi.useFakeTimers();
    const logger = { warn: vi.fn() };
    const probe = createDockerHostCapacityProbe({
      docker: { info: () => new Promise<never>(() => {}) },
      logger,
    });
    const pending = dockerCapabilities({ probe, ...settings });
    await vi.advanceTimersByTimeAsync(DOCKER_CAPACITY_PROBE_TIMEOUT_MS);
    const caps = await pending;
    expect(caps.available).toBe(true);
    expect(caps.unavailableReason).toBeUndefined();
    expect(caps.maxMemoryGb).toBe(128);
    expect(caps.maxCpus).toBe(128);
    expect(caps.hostCapacity).toMatchObject({
      state: 'unverified',
      observedAt: null,
      probeFailure: { kind: 'timeout', durationMs: DOCKER_CAPACITY_PROBE_TIMEOUT_MS },
    });
    expect(caps.hostCapacity?.reason).toContain(
      `the last check timed out after ${DOCKER_CAPACITY_PROBE_TIMEOUT_MS} ms`,
    );
    expect(caps.hostCapacity?.reason).toContain('new containers wait in the queue');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'timeout', durationMs: DOCKER_CAPACITY_PROBE_TIMEOUT_MS }),
      'Docker host capacity check failed',
    );
  });

  it('records a sanitized engine error, reuses a recent report, then marks it unverified with stale bounds', async () => {
    let clock = Date.parse('2026-11-23T10:00:00.000Z');
    const info = vi
      .fn<() => Promise<typeof host>>()
      .mockResolvedValueOnce(host)
      .mockRejectedValue(new Error('connect EACCES /var/run/docker.sock'));
    const probe = createDockerHostCapacityProbe({ docker: { info }, now: () => clock });
    expect((await probe()).state).toBe('live');

    clock += DOCKER_CAPACITY_PROBE_MEMO_MS;
    const cached = await dockerCapabilities({ probe, ...settings });
    expect(cached.maxMemoryGb).toBe(8);
    expect(cached.hostCapacity).toMatchObject({
      state: 'cached',
      observedAt: '2026-11-23T10:00:00.000Z',
      probeFailure: { kind: 'error', message: 'connect EACCES /var/run/docker.sock' },
    });
    expect(cached.hostCapacity?.reason).toContain('using the size it reported');

    clock += DOCKER_CAPACITY_FRESH_MS;
    const stale = await dockerCapabilities({ probe, ...settings });
    expect(stale.available).toBe(true);
    expect(stale.maxMemoryGb).toBe(8);
    expect(stale.maxCpus).toBe(4);
    expect(stale.hostCapacity).toMatchObject({
      state: 'unverified',
      observedAt: '2026-11-23T10:00:00.000Z',
    });
    expect(stale.hostCapacity?.reason).toContain('last reported at 2026-11-23T10:00:00.000Z');
  });

  it('coalesces concurrent checks and memoises both successes and failures', async () => {
    let clock = 0;
    let resolve!: (value: typeof host) => void;
    const info = vi.fn(
      () =>
        new Promise<typeof host>((r) => {
          resolve = r;
        }),
    );
    const probe = createDockerHostCapacityProbe({ docker: { info }, now: () => clock });
    const all = Promise.all([probe(), probe(), probe()]);
    resolve(host);
    expect((await all).map((o) => o.state)).toEqual(['live', 'live', 'live']);
    clock += DOCKER_CAPACITY_PROBE_MEMO_MS - 1;
    await probe();
    expect(info).toHaveBeenCalledTimes(1);

    info.mockImplementation(() => Promise.reject(new Error('engine busy')));
    clock += 1;
    expect((await probe()).state).toBe('cached');
    clock += DOCKER_CAPACITY_PROBE_MEMO_MS - 1;
    expect((await probe()).failure?.message).toBe('engine busy');
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('treats an invalid host report as a failed check', async () => {
    const probe = createDockerHostCapacityProbe({
      docker: { info: async () => ({ MemTotal: 0, NCPU: Number.NaN }) },
    });
    const observation = await probe();
    expect(observation).toMatchObject({
      state: 'unverified',
      host: null,
      failure: { kind: 'error', message: 'Docker reported an invalid host size' },
    });
  });
});
