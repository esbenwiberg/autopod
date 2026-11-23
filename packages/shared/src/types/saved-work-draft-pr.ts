import type { ScanDecision, ScanDetectorName, ScanOutcome, ScanSeverity } from './security-scan.js';

/** Review-only publication. None of these receipts authorize ordinary delivery. */
export interface SavedWorkSource {
  id: string;
  kind: 'sandbox-checkpoint' | 'local-commit';
  commit: string;
  tree: string;
  parent: string | null;
  parentTree: string | null;
  ref: string;
  capturedAt: string | null;
  freshness: 'latest-saved' | 'older-saved' | 'host-commit-only';
  exclusions: string;
}
export interface SavedWorkDraftPreview {
  podId: string;
  generation: number;
  binding: string;
  repository: string;
  baseBranch: string;
  sources: SavedWorkSource[];
  checks: string;
  blockers: string[];
  operation: SavedWorkDraftOperation | null;
}
export interface SavedWorkDraftPrepare {
  requestId: string;
  expectedBinding: string;
  sourceId: string;
}
export interface SavedWorkDraftConfirm {
  requestId: string;
  expectedBinding: string;
  draftOnly: true;
}
export interface SavedWorkDraftCancel {
  requestId: string;
  expectedBinding: string;
}
/** Durable revocation of one exact preparation request, including delayed arrivals. */
export interface SavedWorkDraftPreparationCancellation extends SavedWorkDraftPrepare {
  podId: string;
  actorId: string;
  state: 'cancelled-before-publication';
}
export interface SavedWorkDraftOperation {
  id: string;
  requestId: string;
  podId: string;
  actorId: string;
  generation: number;
  taskId: string;
  originalWorktreePath: string;
  originalContainerId: string | null;
  sourceLocations: string[];
  previewBinding: string;
  confirmationBinding: string;
  repository: string;
  baseBranch: string;
  branch: string;
  source: SavedWorkSource;
  checks: string;
  body: string;
  createdAt: string;
  expiresAt: string;
  state:
    | 'preparing'
    | 'prepared'
    | 'push-uncertain'
    | 'pushed'
    | 'create-uncertain'
    | 'published'
    | 'cancelled';
  message?: string;
  /** Latest publication security scan for this operation's exact prepared bytes. */
  publicationScan?: SavedWorkDraftPublicationScan;
  receipt: { url: string; draft: true; head: string; baseBranch: string; branch: string } | null;
}

/**
 * Redacted publication-scan finding. It names the scanner, rule and location only;
 * matched values and snippets are never recorded.
 */
export interface SavedWorkDraftPublicationScanFinding {
  /** Scanner implementation, e.g. `secretlint`. */
  scanner: string;
  detector: ScanDetectorName;
  ruleId: string | null;
  severity: ScanSeverity;
  file: string;
  line: number | null;
  /** Configured publication outcome for this detector. */
  action: ScanOutcome;
}

export type SavedWorkDraftPublicationScanCode =
  | 'SECURITY_SCAN_BLOCKED'
  | 'SECURITY_SCAN_INCOMPLETE'
  | 'SECURITY_SCAN_FAILED';

export interface SavedWorkDraftPublicationScan {
  /**
   * `blocked`: a finding's configured outcome is block. `incomplete`: the scan ran
   * but did not cover its required scope. `failed`: the scan could not run.
   */
  outcome: 'passed' | 'blocked' | 'incomplete' | 'failed';
  code: SavedWorkDraftPublicationScanCode | null;
  /** `diff` compares with `baseCommit` and ignores unchanged base findings. */
  scope: 'diff' | 'full';
  baseCommit: string | null;
  decision: ScanDecision | null;
  filesScanned: number;
  filesSkipped: number;
  findingCount: number;
  /** Findings whose configured outcome is block. */
  blockingCount: number;
  /** Up to 20 findings, blocking first. */
  findings: SavedWorkDraftPublicationScanFinding[];
  /** Why coverage was incomplete or the scan could not run. */
  reasons: string[];
  scannedAt: string;
}
