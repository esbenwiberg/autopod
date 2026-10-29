import type { OperatorActor } from './podsitter.js';

/** Observed delivery, not an invented daemon push or merge request. */
export interface ExternalDeliveryReceipt {
  id: string;
  podId: string;
  generation: number;
  prUrl: string;
  repository: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  treeSha: string;
  validationTimestamp: string;
  observedAt: string;
  recordedAt: string;
  actor: OperatorActor;
  reason: string;
  retainedSandboxId: string;
  sandboxStatusAtObservation: 'running' | 'stopped';
  worktreePath: string;
  /** Delivery is confirmed; ignored reports have NOT been claimed preserved. */
  reports: 'pending';
}
