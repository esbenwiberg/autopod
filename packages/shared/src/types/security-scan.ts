/**
 * Security scan policy attached to profiles.
 *
 * The daemon runs scans at two checkpoints in the pod lifecycle:
 *  - `provisioning`: after clone, before container start (inbound boundary)
 *  - `push`:         entering the `validating` state (outbound boundary)
 *
 * Each detector can be turned on/off, and each checkpoint can independently
 * decide what to do when a finding above threshold appears (block / warn /
 * escalate). Profiles that omit `securityScan` get a per-profile preset.
 */
export interface SecurityScanPolicy {
  detectors: SecurityScanDetectors;
  provisioning: CheckpointPolicy;
  push: CheckpointPolicy;
  /**
   * Override the default list of always-scanned instruction files.
   * Each entry is a glob relative to the repo root. When omitted, the
   * built-in default list applies.
   */
  alwaysScanPaths?: string[];
}

export interface SecurityScanDetectors {
  secrets: { enabled: boolean };
  pii: { enabled: boolean; threshold?: number };
  injection: { enabled: boolean; threshold?: number };
}

export interface CheckpointPolicy {
  enabled: boolean;
  /** `auto` = diff vs base if a base exists, else fullTree+alwaysScan. */
  scope: 'full' | 'diff' | 'auto';
  onSecret: ScanOutcome;
  onPii: ScanOutcome;
  onInjection: ScanOutcome;
}

export type ScanOutcome = 'block' | 'warn' | 'escalate';

export type ScanCheckpoint = 'provisioning' | 'push';

export type ScanDecision = 'pass' | 'warn' | 'block' | 'escalate';

export type ScanDetectorName = 'secrets' | 'pii' | 'injection';

export type ScanSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ScanFinding {
  detector: ScanDetectorName;
  severity: ScanSeverity;
  file: string;
  line?: number;
  ruleId?: string;
  /** Confidence score in 0..1 — present for ML detectors only. */
  confidence?: number;
  /** Already-redacted form for secrets, raw for PII/injection. */
  snippet: string;
}
