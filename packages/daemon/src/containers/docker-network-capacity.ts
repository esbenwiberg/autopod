import type { DockerNetworkCapacity, DockerNetworkCapacitySeverity } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import type { Logger } from 'pino';
import { retainedCheckpointNetworkIdentities } from '../pods/retained-checkpoint-repository.js';
import { boundedDockerCall, DOCKER_CALL_TIMEOUTS } from './docker-bounds.js';
import { planRetainedNetworkReleases } from './retained-network-release.js';

export const POD_NETWORK_LABEL = 'com.autopod.pod-network';
export const HOST_NETWORK_CAPACITY = 'HOST_NETWORK_CAPACITY';
/** Reclaimable headroom at or below this count is reported as a warning. */
export const NETWORK_HEADROOM_WARNING = 5;
export const DOCKER_SUBNET_EXHAUSTED = 'all predefined address pools have been fully subnetted';
export const NETWORK_CAPACITY_DOCS = 'docs/hosted-daemon-docker-networks.md';

/** Identity encoded in an `autopod-<identity>` pod network name; empty for other names. */
export function podNetworkIdentity(name: string): string {
  return name.startsWith('autopod-') ? name.slice('autopod-'.length) : '';
}

export interface AddressPool {
  base: string;
  size: number;
}

/**
 * Docker's built-in local-scope pools when `default-address-pools` is unset:
 * 172.17-172.31 as /16s plus 192.168.0.0/16 split into /20s (31 subnets, one of
 * which the default `docker0` bridge normally uses).
 */
export const DOCKER_BUILTIN_ADDRESS_POOLS: readonly AddressPool[] = [
  { base: '172.17.0.0/16', size: 16 },
  { base: '172.18.0.0/16', size: 16 },
  { base: '172.19.0.0/16', size: 16 },
  { base: '172.20.0.0/14', size: 16 },
  { base: '172.24.0.0/14', size: 16 },
  { base: '172.28.0.0/14', size: 16 },
  { base: '192.168.0.0/16', size: 20 },
];

interface Cidr {
  network: number;
  prefix: number;
}

export function parseIpv4Cidr(value: string): Cidr | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix > 32) return null;
  const address = octets.reduce((acc, octet) => acc * 256 + octet, 0);
  const block = 2 ** (32 - prefix);
  return { network: Math.floor(address / block) * block, prefix };
}

function contains(outer: Cidr, inner: Cidr): boolean {
  if (inner.prefix < outer.prefix) return false;
  const block = 2 ** (32 - outer.prefix);
  return Math.floor(inner.network / block) * block === outer.network;
}

/** Number of pool-sized subnets the pools can allocate, or null when none are understood. */
export function addressPoolCapacity(pools: readonly AddressPool[]): number | null {
  let total = 0;
  let understood = false;
  for (const pool of pools) {
    const base = parseIpv4Cidr(pool.base);
    if (!base || !Number.isInteger(pool.size) || pool.size < base.prefix || pool.size > 32)
      continue;
    understood = true;
    total += 2 ** (pool.size - base.prefix);
  }
  return understood ? total : null;
}

/** Pool-sized subnets consumed by the given network subnets. Subnets outside every pool are free. */
export function addressPoolUsage(pools: readonly AddressPool[], subnets: string[]): number {
  let used = 0;
  for (const subnet of subnets) {
    const parsed = parseIpv4Cidr(subnet);
    if (!parsed) continue;
    const pool = pools.find((candidate) => {
      const base = parseIpv4Cidr(candidate.base);
      return base ? contains(base, parsed) : false;
    });
    if (!pool) continue;
    used += parsed.prefix < pool.size ? 2 ** (pool.size - parsed.prefix) : 1;
  }
  return used;
}

function configuredPools(info: unknown): AddressPool[] {
  const raw = (info as { DefaultAddressPools?: unknown } | undefined)?.DefaultAddressPools;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const pool = entry as { Base?: unknown; Size?: unknown };
    return typeof pool.Base === 'string' && typeof pool.Size === 'number'
      ? [{ base: pool.Base, size: pool.Size }]
      : [];
  });
}

export function classifyNetworkHeadroom(
  reclaimableHeadroom: number | null,
): DockerNetworkCapacitySeverity {
  if (reclaimableHeadroom === null) return 'unknown';
  if (reclaimableHeadroom <= 0) return 'critical';
  if (reclaimableHeadroom <= NETWORK_HEADROOM_WARNING) return 'warning';
  return 'ok';
}

export interface InspectNetworkCapacityOptions {
  docker: Dockerode;
  db?: Database.Database;
  logger?: Logger;
}

/**
 * Read-only snapshot of Docker bridge address-pool pressure and autopod pod
 * networks. Never mutates Docker. Unknown values stay null instead of being
 * presented as healthy.
 */
export async function inspectNetworkCapacity({
  docker,
  db,
  logger,
}: InspectNetworkCapacityOptions): Promise<DockerNetworkCapacity> {
  const checkedAt = new Date().toISOString();
  let held: Set<string> | null = null;
  if (db) {
    try {
      held = retainedCheckpointNetworkIdentities(db);
    } catch (err) {
      logger?.warn({ err }, 'Retained network identities unavailable for capacity check');
    }
  }

  let pools: readonly AddressPool[] = DOCKER_BUILTIN_ADDRESS_POOLS;
  let poolSource: DockerNetworkCapacity['addressPools']['source'] = 'unknown';
  try {
    const info = await boundedDockerCall(docker.info() as Promise<unknown>, {
      label: 'info',
      timeoutMs: DOCKER_CALL_TIMEOUTS.inspect,
      logger,
    });
    const configured = configuredPools(info);
    if (configured.length > 0) {
      pools = configured;
      poolSource = 'configured';
    } else {
      poolSource = 'builtin-default';
    }
  } catch (err) {
    logger?.warn({ err }, 'Docker info unavailable for network capacity check');
  }

  const networks = await boundedDockerCall(docker.listNetworks(), {
    label: 'network.list',
    timeoutMs: DOCKER_CALL_TIMEOUTS.listNetworks,
    logger,
  });
  const subnets = networks
    .filter((network) => (network.Scope ?? 'local') === 'local')
    .flatMap((network) => (network.IPAM?.Config ?? []).map((config) => config.Subnet ?? ''));
  const capacity = poolSource === 'unknown' ? null : addressPoolCapacity(pools);
  const used = capacity === null ? null : addressPoolUsage(pools, subnets);

  const podNetworks = networks.filter((network) => network.Labels?.[POD_NETWORK_LABEL] === 'true');
  let retained = 0;
  let attached = 0;
  let unattached = 0;
  let reclaimable = 0;
  let unknown = 0;
  await Promise.all(
    podNetworks.map(async (network) => {
      const isRetained = held?.has(podNetworkIdentity(network.Name)) === true;
      if (isRetained) retained++;
      try {
        const live = await boundedDockerCall(docker.getNetwork(network.Id).inspect(), {
          label: 'network.inspect (capacity)',
          timeoutMs: DOCKER_CALL_TIMEOUTS.inspectNetwork,
          logger,
        });
        if (Object.keys(live?.Containers ?? {}).length > 0) {
          attached++;
          return;
        }
        unattached++;
        if (held !== null && !isRetained) reclaimable++;
      } catch {
        unknown++;
      }
    }),
  );

  const free = capacity === null || used === null ? null : Math.max(0, capacity - used);
  // Superseded retained bridges the subnet-exhaustion path may release (#565).
  let releasable: number | null = null;
  if (db && held !== null) {
    try {
      releasable = (await planRetainedNetworkReleases({ docker, db, logger })).filter(
        (candidate) => candidate.eligible,
      ).length;
    } catch (err) {
      logger?.warn({ err }, 'Retained bridge release plan unavailable for capacity check');
    }
  }
  const reclaimableHeadroom =
    free === null || (db && held !== null && releasable === null)
      ? null
      : free + reclaimable + (releasable ?? 0);
  return {
    checkedAt,
    severity: classifyNetworkHeadroom(reclaimableHeadroom),
    addressPools: {
      source: poolSource,
      capacity,
      used,
      free,
    },
    podNetworks: {
      total: podNetworks.length,
      retained: held === null ? null : retained,
      attached,
      unattached,
      reclaimable: held === null ? null : reclaimable,
      releasable,
      unknown,
    },
    reclaimableHeadroom,
  };
}
