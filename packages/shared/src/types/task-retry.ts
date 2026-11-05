import type { OperatorActor } from './podsitter.js';

/** Trusted captured inputs. Null means unavailable, never evidence of change. */
export interface TaskRetryIdentity {
  source: string | null;
  contract: string | null;
  commands: string | null;
  environment: string | null;
  implementation: string | null;
}
export type TaskRetryStage = 'validation' | 'sandbox_startup' | 'codex_interruption' | 'worker';
export type TaskRetryOutcome = 'pass' | 'nonretryable' | 'transient' | 'cancelled' | 'unknown';
export interface TaskRetryAttempt {
  id: string;
  taskId: string;
  podId: string;
  stage: TaskRetryStage;
  identity: TaskRetryIdentity;
  retryKind: 'transient' | 'changed_conditions' | 'override' | null;
  admittedAt: string;
  notBefore: string;
  /** Absolute provider cooldown; retained across same-binding retry ancestry. */
  providerRetryNotBefore?: string | null;
  startedAt: string | null;
  endedAt: string | null;
  outcome: TaskRetryOutcome | null;
  measuredDurationMs: number | null;
}
export interface RewriteRepairRetryTarget {
  recoveryId: string;
  candidateHead: string;
  candidateTree: string;
}
export interface TaskRetryAuthorization {
  id: string;
  requestKey: string;
  taskId: string;
  podId: string;
  stage: TaskRetryStage;
  failureId: string;
  actor: OperatorActor;
  reason: string;
  createdAt: string;
  usedByAttemptId: string | null;
  /** Exact worker provider binding explicitly selected during operator recovery. */
  targetBindingHash?: string;
  rewriteRepair?: RewriteRepairRetryTarget & {
    generation: number;
    requestHash: string;
    configurationHash: string;
    rewriteId: string;
    failedDispatchId: string;
  };
}
export interface TaskRetryState {
  taskId: string;
  stage: TaskRetryStage;
  backoffsMs: number[] | null;
  admissionCount: number;
  executedCount: number;
  transientRetryCount: number;
  /** Sum of valid recorded elapsed values for this stage; null if the subtotal is unsafe. */
  measuredDurationMs: number | null;
  durationEvidence?: {
    measuredRecordCount: number;
    unavailableRecordCount: number;
    pendingRecordCount: number;
    basis: 'stage_elapsed_subtotal';
    additiveAcrossStages: false;
  };
  interruptedCount: number;
  latest: TaskRetryAttempt | null;
  authorizations: TaskRetryAuthorization[];
  /** Worker retry permission is still required, including unstarted retries of that failure. */
  authorizationRequired?: boolean;
  /** Governing classified worker failure, including unstarted retry ancestry. */
  retryFailure?: 'auth' | 'transient' | 'unknown' | null;
  telemetry: 'partial';
}

/** Read-only projection. Final Rework admission always rechecks current facts. */
export interface ReworkEligibility {
  eligible: boolean;
  status: 'eligible' | 'grant_recorded' | 'authorization_needed' | 'cooldown' | 'blocked';
  reason: string;
  generation: number;
  failureId: string | null;
  notBefore?: string;
}

export interface ReworkRequestInput {
  requestKey: string;
  generation: number;
  guidance: string;
}
export interface ReworkRequestReceipt extends ReworkRequestInput {
  taskId: string;
  podId: string;
  actor: OperatorActor;
  createdAt: string;
  settledAt: string | null;
  error: string | null;
}
