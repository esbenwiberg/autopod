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
}
