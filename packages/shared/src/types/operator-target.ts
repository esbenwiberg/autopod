import type { EscalationRequest } from './escalation.js';
import type { ReadinessReview } from './readiness.js';
import type { ValidationResult } from './validation.js';

/** Recorded decision/validation identity, not a grant of authority or an OS source lock. */
export interface OperatorTarget {
  version: 1;
  podId: string;
  lifecycleGeneration: number;
  status: string;
  expectedTarget: string;
  escalationId: string | null;
  escalationType: string | null;
  /** Read the actual current question, not only a fresh token for an old notification. */
  pendingEscalation: EscalationRequest | null;
  validation: Pick<ValidationResult, 'attempt' | 'timestamp' | 'overall' | 'taskReview'> | null;
  readiness: Pick<ReadinessReview, 'status' | 'summary'> | null;
  prUrl: string | null;
}
export interface GuardedOperatorAction {
  action: 'reply' | 'approve' | 'nudge';
  expectedTarget: string;
  /** Caller session label; the daemon also binds it to the authenticated operator. */
  actor: string;
  message?: string;
}
