import type { OperatorActor } from './podsitter.js';

export interface IntentionalRerun {
  ofPodId: string;
  requestKey: string;
  reason: string;
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
  conflicts: Array<{
    podId: string;
    executionId: string;
    status: string;
    evidence: 'dispatch_receipt' | 'legacy_request';
  }>;
  rerun: (IntentionalRerun & { actor: OperatorActor; recordedAt: string }) | null;
  checkedAt: string;
}
