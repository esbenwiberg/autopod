import type { ScanDetectorName, ScanFinding } from '@autopod/shared';
import type { ScanFile } from '../file-walker.js';

/**
 * Contract for a single security detector. Each detector runs over one file
 * at a time and returns zero or more findings. Detectors may be ML-backed
 * (lazy `warmup`), regex-backed (`warmup` is a no-op), or wrap an external
 * library.
 */
export interface Detector {
  readonly name: ScanDetectorName;
  /** Idempotent. Pre-load any models or rule sets. */
  warmup(): Promise<void>;
  /** Scan a single file. Implementations MUST NOT throw — return [] on error. */
  scan(file: ScanFile): Promise<ScanFinding[]>;
  /**
   * Optional daemon-private scan output for safe occurrence baselining.
   * Returns null on detector failure so callers fail closed and retain all
   * current findings. The opaque identity must never be copied into the
   * public finding.
   */
  scanWithBaselineIdentity?(file: ScanFile): Promise<BaselineFinding[] | null>;
}

export interface BaselineFinding {
  finding: ScanFinding;
  identity: string;
}
