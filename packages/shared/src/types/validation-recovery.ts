export type ValidationRecoveryAction = 'fix-validation' | 'retry-checks';

export interface ValidationRecoveryAvailability {
  allowed: boolean;
  reason?: string;
  code?: string;
}

/** Eligibility is advisory; every POST rechecks the current lifecycle and existing ledgers. */
export interface ValidationRecoveryState {
  generation: number;
  validationTimestamp: string | null;
  fixValidation: ValidationRecoveryAvailability;
  retryChecks: ValidationRecoveryAvailability;
  activeAction: ValidationRecoveryAction | null;
  /** Request outcome only, not a fabricated validation result or durable retry grant. */
  lastError?: { code: string; message: string };
}
