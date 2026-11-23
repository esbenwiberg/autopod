import {
  AutopodError,
  describeExecutionCapacityProbeFailure,
  type ExecutionCapabilities,
  type ExecutionCapacityProbeFailure,
  type ExecutionHostCapacity,
  processContent,
} from '@autopod/shared';
import type Dockerode from 'dockerode';
import type { Logger } from 'pino';
import { boundedDockerCall, DockerCallTimeoutError } from '../containers/docker-bounds.js';
import {
  SANDBOX_TIERS,
  type SandboxDefaultTier,
  sandboxTier,
  sandboxTierLabel,
} from '../containers/sandbox-tiers.js';

const gib = 1024 ** 3;
const sidecarDefaults: ExecutionCapabilities['sidecarDefaults'] = {
  'dagger-engine': { memoryGb: 2, cpus: 1, storageGb: null },
  postgres: { memoryGb: 1, cpus: 1, storageGb: null },
  redis: { memoryGb: 0.5, cpus: 0.5, storageGb: null },
};

/**
 * Derived from the same sandbox tier catalog as provisioning. The configured
 * default (≤ L) is reported separately from the 3XL maximum.
 */
export function sandboxCapabilities(options: {
  enabled: boolean;
  defaultTier: SandboxDefaultTier;
}): ExecutionCapabilities {
  const tiers = SANDBOX_TIERS.map((entry) => entry.memoryGiB);
  const maxMemoryGb = Math.max(...tiers);
  return {
    target: 'sandbox',
    available: options.enabled,
    ...(options.enabled
      ? {}
      : { unavailableReason: 'Hosted sandbox is not configured on this daemon' }),
    defaults: {
      memoryGb: sandboxTier(options.defaultTier).memoryGiB,
      cpus: null,
      storageGb: null,
    },
    maxMemoryGb,
    maxCpus: null,
    maxStorageGb: null,
    memoryTiersGb: tiers,
    memoryBundles: SANDBOX_TIERS.map((entry) => ({
      tier: entry.tier,
      memoryGb: entry.memoryGiB,
      cpus: entry.vcpu,
      diskGb: entry.diskGiB,
      label: sandboxTierLabel(entry.tier),
    })),
    sidecars: false,
    privilegedSidecars: false,
    sidecarStorageLimit: false,
    maxTotalMemoryGb: maxMemoryGb,
    maxTotalCpus: null,
    sidecarDefaults,
  };
}

/** Docker host-capacity check tuning (#665). */
export const DOCKER_CAPACITY_PROBE_TIMEOUT_MS = 10_000;
/** Every outcome (success or failure) is reused this long, coalescing ~50 call sites. */
export const DOCKER_CAPACITY_PROBE_MEMO_MS = 30_000;
/** A successful report stays authoritative this long after later checks fail. */
export const DOCKER_CAPACITY_FRESH_MS = 30 * 60_000;

export interface DockerHostCapacityObservation {
  state: ExecutionHostCapacity['state'];
  /** Last size Docker reported, possibly stale when `unverified`. */
  host: { memTotalBytes: number; ncpu: number; observedAt: string } | null;
  /** Latest failed check when the state is not `live`. */
  failure: ExecutionCapacityProbeFailure | null;
}
export type DockerHostCapacityProbe = () => Promise<DockerHostCapacityObservation>;

function sanitizeProbeMessage(err: unknown): string {
  const raw = err instanceof Error && err.message.trim() ? err.message : String(err);
  return (
    processContent(raw.slice(0, 300), { sanitization: { preset: 'standard' } }).text.trim() ||
    'unknown error'
  );
}

/**
 * One shared `docker info` reader per daemon. Concurrent callers share one call, each
 * outcome is memoised for `memoMs`, and the last successful size stays usable for
 * `freshMs`. A failed or slow check is transient: it never reports Docker as absent.
 */
export function createDockerHostCapacityProbe(options: {
  docker: Pick<Dockerode, 'info'>;
  logger?: Pick<Logger, 'warn'>;
  now?: () => number;
  timeoutMs?: number;
  memoMs?: number;
  freshMs?: number;
}): DockerHostCapacityProbe {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DOCKER_CAPACITY_PROBE_TIMEOUT_MS;
  const memoMs = options.memoMs ?? DOCKER_CAPACITY_PROBE_MEMO_MS;
  const freshMs = options.freshMs ?? DOCKER_CAPACITY_FRESH_MS;
  let lastGood: { memTotalBytes: number; ncpu: number; observedAtMs: number } | null = null;
  let last: { atMs: number; failure: ExecutionCapacityProbeFailure | null } | null = null;
  let inflight: Promise<void> | null = null;

  async function check(): Promise<void> {
    const started = now();
    try {
      const info = await boundedDockerCall(options.docker.info(), {
        label: 'configuration.dockerInfo',
        timeoutMs,
      });
      const memTotalBytes = Number(info?.MemTotal);
      const ncpu = Number(info?.NCPU);
      if (
        !Number.isFinite(memTotalBytes) ||
        !Number.isFinite(ncpu) ||
        memTotalBytes <= 0 ||
        ncpu <= 0
      )
        throw new Error('Docker reported an invalid host size');
      const finished = now();
      lastGood = { memTotalBytes, ncpu, observedAtMs: finished };
      last = { atMs: finished, failure: null };
    } catch (err) {
      const finished = now();
      const failure: ExecutionCapacityProbeFailure = {
        kind: err instanceof DockerCallTimeoutError ? 'timeout' : 'error',
        message: sanitizeProbeMessage(err),
        durationMs: Math.max(0, Math.round(finished - started)),
        at: new Date(finished).toISOString(),
      };
      last = { atMs: finished, failure };
      options.logger?.warn(
        { err, kind: failure.kind, durationMs: failure.durationMs },
        'Docker host capacity check failed',
      );
    }
  }

  function observe(): DockerHostCapacityObservation {
    const failure = last?.failure ?? null;
    const host = lastGood
      ? {
          memTotalBytes: lastGood.memTotalBytes,
          ncpu: lastGood.ncpu,
          observedAt: new Date(lastGood.observedAtMs).toISOString(),
        }
      : null;
    if (!failure && host) return { state: 'live', host, failure: null };
    const fresh = lastGood !== null && now() - lastGood.observedAtMs <= freshMs;
    return { state: fresh ? 'cached' : 'unverified', host, failure };
  }

  return async () => {
    if (!last || now() - last.atMs >= memoMs) {
      inflight ??= check().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    return observe();
  };
}

function hostCapacityReport(observation: DockerHostCapacityObservation): ExecutionHostCapacity {
  const observedAt = observation.host?.observedAt ?? null;
  if (observation.state === 'live') return { state: 'live', observedAt };
  const failure = observation.failure;
  const cause = failure
    ? `the last check ${describeExecutionCapacityProbeFailure(failure)} at ${failure.at}`
    : 'no check has completed';
  const reason =
    observation.state === 'cached'
      ? `Docker did not answer the host capacity check (${cause}); using the size it reported at ${observedAt}.`
      : `Docker host capacity is unverified: ${cause}; ${
          observedAt
            ? `last reported at ${observedAt}`
            : 'Docker has not reported it since the daemon started'
        }. Launches are admitted and running pods continue; new containers wait in the queue until Docker reports it.`;
  return {
    state: observation.state,
    observedAt,
    ...(failure ? { probeFailure: failure } : {}),
    reason,
  };
}

/**
 * Host permission is an operator setting, independent of any repository/profile/launch.
 * Only a missing Docker client or a default above the host/operator limit is permanent.
 * An unanswered host-size check is transient (`hostCapacity.state === 'unverified'`):
 * bounds fall back to the last reported size, else the operator ceiling.
 */
export async function dockerCapabilities(options: {
  probe: DockerHostCapacityProbe | null;
  privilegedSidecars: boolean;
  limits: { memoryGb: number; cpus: number };
  defaults: { memoryGb: number; cpus: number };
}): Promise<ExecutionCapabilities> {
  let memoryGb = 0;
  let cpus = 0;
  let unavailableReason: string | undefined;
  let hostCapacity: ExecutionHostCapacity | undefined;
  if (!options.probe) {
    unavailableReason = 'Docker is not configured on this daemon';
  } else {
    const observation = await options.probe();
    hostCapacity = hostCapacityReport(observation);
    memoryGb = Math.min(
      observation.host ? observation.host.memTotalBytes / gib : options.limits.memoryGb,
      options.limits.memoryGb,
    );
    cpus = Math.min(observation.host?.ncpu ?? options.limits.cpus, options.limits.cpus);
    if (options.defaults.memoryGb > memoryGb || options.defaults.cpus > cpus)
      unavailableReason = 'Configured default allocation exceeds the Docker host or operator limit';
  }
  return {
    target: 'local',
    available: unavailableReason === undefined,
    ...(unavailableReason ? { unavailableReason } : {}),
    ...(hostCapacity ? { hostCapacity } : {}),
    defaults: { ...options.defaults, storageGb: null },
    maxMemoryGb: memoryGb,
    maxCpus: cpus,
    maxStorageGb: null,
    memoryTiersGb: null,
    memoryBundles: null,
    sidecars: true,
    privilegedSidecars: options.privilegedSidecars,
    sidecarStorageLimit: false,
    maxTotalMemoryGb: memoryGb,
    maxTotalCpus: cpus,
    sidecarDefaults,
  };
}

/**
 * Raised only by the provisioning gate: a queued pod must not create a workspace or
 * container until Docker reports host capacity. Transient; the pod waits in the queue.
 */
export class ExecutionCapacityUnverifiedError extends AutopodError {
  readonly hostCapacity: ExecutionHostCapacity;
  constructor(hostCapacity: ExecutionHostCapacity) {
    super(
      hostCapacity.reason ?? 'Docker host capacity is unverified',
      'EXECUTION_CAPACITY_UNVERIFIED',
      503,
    );
    this.name = 'ExecutionCapacityUnverifiedError';
    this.hostCapacity = hostCapacity;
  }
}

export function isExecutionCapacityUnverified(
  err: unknown,
): err is ExecutionCapacityUnverifiedError {
  return err instanceof ExecutionCapacityUnverifiedError;
}
