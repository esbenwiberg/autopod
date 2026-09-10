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
export interface DaemonHealthSummary {
  status: string;
  version: string;
  timestamp?: string;
  requestDurationMs?: number;
  release?: DaemonReleaseInfo;
  backup?: BackupHealth;
}
