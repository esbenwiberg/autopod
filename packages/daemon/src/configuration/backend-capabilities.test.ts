import type Dockerode from 'dockerode';
import { describe, expect, it } from 'vitest';
import { dockerCapabilities, sandboxCapabilities } from './backend-capabilities.js';

describe('reported backend capabilities', () => {
  it('reports the provisioning sandbox tiers and configured default without inventing larger sizes', () => {
    const caps = sandboxCapabilities({ enabled: true, defaultTier: 'L' });
    expect(caps.memoryTiersGb).toEqual([0.5, 1, 2, 4]);
    expect(caps.defaults.memoryGb).toBe(4);
    expect(caps.sidecars).toBe(false);
    expect(caps.maxCpus).toBeNull();
    expect(sandboxCapabilities({ enabled: false, defaultTier: 'M' }).available).toBe(false);
  });
  it('bounds Docker allocations by both actual capacity and operator limits', async () => {
    const info = async () => ({ MemTotal: 8 * 1024 ** 3, NCPU: 4 });
    const caps = await dockerCapabilities({
      docker: { info } as unknown as Pick<Dockerode, 'info'>,
      privilegedSidecars: false,
      limits: { memoryGb: 16, cpus: 2 },
      defaults: { memoryGb: 2, cpus: 1 },
    });
    expect(caps.maxMemoryGb).toBe(8);
    expect(caps.maxCpus).toBe(2);
    expect(caps.privilegedSidecars).toBe(false);
    expect(caps.maxStorageGb).toBeNull();
    expect(caps.sidecarStorageLimit).toBe(false);
    const offline = await dockerCapabilities({
      docker: null,
      privilegedSidecars: false,
      limits: { memoryGb: 16, cpus: 2 },
      defaults: { memoryGb: 2, cpus: 1 },
    });
    expect(offline.available).toBe(false);
    expect(offline.unavailableReason).toContain('unavailable');
  });
});
