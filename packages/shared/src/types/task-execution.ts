import type { CostEvidence } from './pod.js';

/** Counts refer to one durable linked task, not delivery or successful acceptance. */
export interface TaskExecutionSummary {
  taskId: string;
  executionId: string;
  rootPodId: string;
  podCount: number;
  agentRunCount: number;
  failedRunCount: number;
  transientFailureCount: number;
  providerAttemptCount: number;
  validationExecutionCount: number;
  /** Ledger-only counts; historical PR URLs are not reconstructed provider receipts. */
  delivery?: {
    intentCount: number;
    receiptCount: number;
    unresolvedCount: number;
    scope: 'durable-receipts-only';
    /** Latest stored observation per PR receipt; absence means older server evidence is unavailable. */
    disposition?: {
      openCount: number;
      mergedCount: number;
      closedCount: number;
      unavailableCount: number;
      basis: 'last-recorded';
      liveVerified: false;
    };
  };
  tokenBudget: number | null;
  /** Admission check of recorded usage; this does not reserve future provider spending. */
  budgetCheck?: {
    status: 'unlimited' | 'below_recorded_limit' | 'exhausted' | 'unavailable';
    reason: string;
  };
  recordedInputTokens: number;
  recordedOutputTokens: number;
  recordedCostUsd: number;
  costEvidence?: CostEvidence;
  infrastructureCostUsd: number | null;
  telemetry: 'partial' | 'complete';
  diagnostics: string[];
}
