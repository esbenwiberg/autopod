import type { OperatorActor } from './podsitter.js';

export interface UnverifiedTaskRun {
  runId: string;
  podId: string;
  generation: number;
  cycle: number;
  /** Historical dispatch binding, not the pod's current resource. Null fails closed. */
  resource: { containerId: string; executionTarget: 'sandbox' } | null;
}

export interface TerminationReconciliationReceipt {
  runId: string;
  podId: string;
  taskId: string;
  generation: number;
  cycle: number;
  resource: { containerId: string; executionTarget: 'sandbox' };
  actor: Extract<OperatorActor, { type: 'human' }>;
  reason: string;
  proof: 'sandbox-deleted';
  observedAt: string;
  reconciledAt: string;
  /** Original process exit code remains unknown; this is not successful completion. */
  originalFailureCategory: 'execution_termination_unverified';
}

export interface TerminationReconciliationState {
  pending: UnverifiedTaskRun[];
  receipts: TerminationReconciliationReceipt[];
}
