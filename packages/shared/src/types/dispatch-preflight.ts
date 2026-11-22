import type { OperatorActor } from './podsitter.js';

export interface IntentionalRerun {
  ofPodId: string;
  requestKey: string;
  reason: string;
}
/**
 * Evidence-based, advisory liveness assessment of a conflicting execution.
 * `stale` never authorizes dispatch by itself; it only explains the conflict.
 */
export interface DispatchConflictAssessment {
  classification: 'active' | 'stale';
  reasons: string[];
}
export interface DispatchConflict {
  podId: string;
  executionId: string;
  status: string;
  evidence: 'dispatch_receipt' | 'legacy_request';
  /** Absent on receipts recorded before assessments existed. */
  assessment?: DispatchConflictAssessment;
}
/** Side-effect-free equivalent-work check for a launch that has not been admitted yet. */
export interface DispatchPreview {
  status: 'clear' | 'review_required' | 'authorized' | 'not_applicable';
  repository: string | null;
  baseBranch: string | null;
  conflicts: DispatchConflict[];
  /** Human-runnable fixes for a review_required result. */
  suggestedActions: string[];
}
export interface DispatchPreflightEvidence {
  id: string;
  version: 1;
  podId: string;
  executionId: string;
  taskId: string;
  generation: number;
  repository: string;
  baseBranch: string;
  baseCommitSha: string;
  workHash: string;
  status: 'admitted' | 'review_required';
  conflicts: DispatchConflict[];
  rerun: (IntentionalRerun & { actor: OperatorActor; recordedAt: string }) | null;
  checkedAt: string;
}
