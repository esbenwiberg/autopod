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
 * custody (the subnet-exhaustion prune can free those). Null means unknown.
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
