import type { OperatorActor } from './podsitter.js';

export interface ValidationExecutionBinding {
  podId: string;
  taskId: string;
  generation: number;
  cycle: number;
  attempt: number;
  admissionId: string;
  executionTarget: 'sandbox';
  containerId: string;
  resourceScope: string;
  worktreePath: string;
  providerBinding: string;
}
export interface ValidationSettlementReceipt {
  dispatchId: string;
  binding: ValidationExecutionBinding;
  resultHash: string;
  actor: OperatorActor;
  reason: string;
  proof: 'sandbox-deleted';
  observedAt: string;
  snapshot: string;
  checkpointCommit: string;
  /** Historical resource absence, not final-content proof, an observed exit or passing tests. */
  reconciledAt: string;
}
export interface ValidationExecutionRecoveryState {
  generation: number;
  validationTimestamp: string | null;
  resultHash: string | null;
  dispatchId: string | null;
  binding: ValidationExecutionBinding | null;
  required: boolean;
  settled: boolean;
  allowed: boolean;
  reason?: string;
  code?: string;
  operation: 'preservation-required' | 'deletion-outcome-pending' | 'settled' | null;
  receipt: ValidationSettlementReceipt | null;
  testBudgets: ValidationRecoveryBudgetReceipt[];
  preservationAttempts: Array<{
    id: string;
    startedAt: string;
    settledAt: string | null;
    outcome: 'failed' | 'preserved' | null;
  }>;
}
export interface ValidationExecutionRecoveryRequest {
  expectedGeneration: number;
  expectedResultHash: string;
  reason: string;
}

export interface ValidationRecoveryBudgetReceipt {
  id: string;
  generation: number;
  resultHash: string;
  seconds: number;
  actor: OperatorActor;
  reason: string;
  createdAt: string;
  expiresAt: string;
  consumedByDispatchId: string | null;
}
