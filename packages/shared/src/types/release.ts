export interface DaemonReleaseInfo {
  /** SHA-256 of bounded source/build/dependency inputs; unavailable when not embedded. */
  validationImplementationHash?: string | null;
  commitSha: string | null;
  dirty: boolean | null;
  builtAt: string | null;
  source: 'build' | 'unavailable';
}
export interface BackupHealth {
  state: 'fresh' | 'stale' | 'missing' | 'failed' | 'low_headroom' | 'unavailable';
  sourceIdentity?: string;
  ageMs?: number | null;
  lastCompletedAt?: string | null;
  availableBytes?: number;
  requiredBytes?: number;
  snapshotIntegrity?: 'verified' | 'unverified';
}
export type DockerNetworkCapacitySeverity = 'ok' | 'warning' | 'critical' | 'unknown';
/**
 * Read-only Docker bridge address-pool pressure. `reclaimableHeadroom` is free
 * pool subnets plus unattached autopod networks that are not held by retained
 * custody, plus superseded retained bridges eligible for release (the
 * subnet-exhaustion path can free both). Null means unknown.
 */
export interface DockerNetworkCapacity {
  checkedAt: string;
  severity: DockerNetworkCapacitySeverity;
  addressPools: {
    source: 'configured' | 'builtin-default' | 'unknown';
    capacity: number | null;
    used: number | null;
    free: number | null;
  };
  podNetworks: {
    total: number;
    retained: number | null;
    attached: number;
    unattached: number;
    reclaimable: number | null;
    /** Superseded retained bridges eligible for the release protocol. */
    releasable: number | null;
    unknown: number;
  };
  reclaimableHeadroom: number | null;
}
export interface DaemonHealthSummary {
  status: string;
  version: string;
  timestamp?: string;
  requestDurationMs?: number;
  release?: DaemonReleaseInfo;
  backup?: BackupHealth;
  /** Present only for `/health?detail=full` on daemons that report it. */
  docker?: {
    connected?: boolean;
    containers_running?: number;
    networks?: DockerNetworkCapacity | { error: string };
  };
}

export type RetainedNetworkSource = 'retained_checkpoint' | 'artifact_checks';
export type RetainedNetworkReleaseTrigger = 'subnet_pressure' | 'operator';
export interface ObservedContainer {
  id: string;
  name: string;
  status: string;
}
/** One held bridge in Docker and whether the release protocol may remove it. */
export interface RetainedNetworkCandidate {
  identity: string;
  ownerPodId: string;
  source: RetainedNetworkSource;
  networkId: string;
  networkName: string;
  created: string | null;
  eligible: boolean;
  /** Why the bridge is not releasable; absent when eligible. */
  reason?: string;
  containers: ObservedContainer[];
}
export interface RetainedNetworkReleaseResult {
  identity: string;
  networkId: string;
  networkName: string;
  outcome: 'removed' | 'already_absent' | 'failed' | 'refused';
  releaseId?: string;
  detail?: string;
}
export interface RetainedNetworkReleasePlan {
  eligible: number;
  candidates: RetainedNetworkCandidate[];
}
export interface RetainedNetworkReleaseReport {
  released: number;
  results: RetainedNetworkReleaseResult[];
}
