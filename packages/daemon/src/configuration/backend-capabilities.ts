import type { ExecutionCapabilities } from '@autopod/shared';
import type Dockerode from 'dockerode';
import { boundedDockerCall } from '../containers/docker-bounds.js';
import { SANDBOX_TIER_MEMORY_BYTES } from '../containers/sandbox-api-client.js';

const gib = 1024 ** 3;
const sidecarDefaults: ExecutionCapabilities['sidecarDefaults'] = {
  'dagger-engine': { memoryGb: 2, cpus: 1, storageGb: null },
  postgres: { memoryGb: 1, cpus: 1, storageGb: null },
  redis: { memoryGb: 0.5, cpus: 0.5, storageGb: null },
};

/** Uses the same sandbox tier constants as provisioning, including its configured default. */
export function sandboxCapabilities(options: {
  enabled: boolean;
  defaultTier: keyof typeof SANDBOX_TIER_MEMORY_BYTES;
}): ExecutionCapabilities {
  const tiers = Object.values(SANDBOX_TIER_MEMORY_BYTES)
    .map((n) => n / gib)
    .sort((a, b) => a - b);
  const maxMemoryGb = Math.max(...tiers);
  return {
    target: 'sandbox',
    available: options.enabled,
    ...(options.enabled
      ? {}
      : { unavailableReason: 'Hosted sandbox is not configured on this daemon' }),
    defaults: {
      memoryGb: SANDBOX_TIER_MEMORY_BYTES[options.defaultTier] / gib,
      cpus: null,
      storageGb: null,
    },
    maxMemoryGb,
    maxCpus: null,
    maxStorageGb: null,
    memoryTiersGb: tiers,
    sidecars: false,
    privilegedSidecars: false,
    sidecarStorageLimit: false,
    maxTotalMemoryGb: maxMemoryGb,
    maxTotalCpus: null,
    sidecarDefaults,
  };
}

/** Host permission is an operator setting, independent of any repository/profile/launch. */
export async function dockerCapabilities(options: {
  docker: Pick<Dockerode, 'info'> | null;
  privilegedSidecars: boolean;
  limits: { memoryGb: number; cpus: number };
  defaults: { memoryGb: number; cpus: number };
}): Promise<ExecutionCapabilities> {
  let memoryGb = 0;
  let cpus = 0;
  let unavailableReason: string | undefined;
  try {
    if (!options.docker) throw new Error('unavailable');
    const info = await boundedDockerCall(options.docker.info(), {
      label: 'configuration.dockerInfo',
      timeoutMs: 5_000,
    });
    memoryGb = Math.min(info.MemTotal / gib, options.limits.memoryGb);
    cpus = Math.min(info.NCPU, options.limits.cpus);
    if (!Number.isFinite(memoryGb) || !Number.isFinite(cpus) || memoryGb <= 0 || cpus <= 0)
      throw new Error('invalid host capacity');
    if (options.defaults.memoryGb > memoryGb || options.defaults.cpus > cpus)
      unavailableReason = 'Configured default allocation exceeds the Docker host or operator limit';
  } catch {
    unavailableReason = 'Docker capacity is unavailable on this daemon';
  }
  return {
    target: 'local',
    available: unavailableReason === undefined,
    ...(unavailableReason ? { unavailableReason } : {}),
    defaults: { ...options.defaults, storageGb: null },
    maxMemoryGb: memoryGb,
    maxCpus: cpus,
    maxStorageGb: null,
    memoryTiersGb: null,
    sidecars: true,
    privilegedSidecars: options.privilegedSidecars,
    sidecarStorageLimit: false,
    maxTotalMemoryGb: memoryGb,
    maxTotalCpus: cpus,
    sidecarDefaults,
  };
}
