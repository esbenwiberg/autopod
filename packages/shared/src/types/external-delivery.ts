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
  /** Actual merged PR source, distinct from retained headSha/treeSha. Absent on legacy exact receipts. */
  mergedHeadSha?: string;
  /** Provider-proven inclusion, not validation or approval of the additional commits. */
  ancestry?: {
    publishedHeadSha: string;
    mergedHeadSha: string;
    target: { repository: string; branch: string; baseBranch: string };
    observedAt: string;
  };
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
