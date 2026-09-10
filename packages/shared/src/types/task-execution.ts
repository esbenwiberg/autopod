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
  /** Canonical PRs with a source-bound intent in this task. No reconstruction from pod status. */
  merge?: {
    prCount: number;
    /** Actual durable admissions for this task, including repeated acknowledged attempts. */
    requestCount: number;
    mergedPrCount: number;
    /** Last source-bound status was closed without merge; unavailable on older servers. */
    closedPrCount?: number;
    /** No request recorded for that PR in any task when its merge was observed. Does not identify an actor. */
    mergedWithoutRecordedRequestCount: number;
    unresolvedPrCount: number;
    scope: 'source-bound-journal-only';
    basis: 'last-recorded';
    liveVerified: false;
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
