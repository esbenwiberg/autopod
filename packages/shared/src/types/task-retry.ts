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
  startedAt: string | null;
  endedAt: string | null;
  outcome: TaskRetryOutcome | null;
  measuredDurationMs: number | null;
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
}
export interface TaskRetryState {
  taskId: string;
  stage: TaskRetryStage;
  backoffsMs: number[] | null;
  admissionCount: number;
  executedCount: number;
  transientRetryCount: number;
  measuredDurationMs: number;
  interruptedCount: number;
  latest: TaskRetryAttempt | null;
  authorizations: TaskRetryAuthorization[];
  /** Worker retry permission is still required, including unstarted retries of that failure. */
  authorizationRequired?: boolean;
  /** Governing classified worker failure, including unstarted retry ancestry. */
  retryFailure?: 'auth' | 'transient' | null;
  telemetry: 'partial';
}
