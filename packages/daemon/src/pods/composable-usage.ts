import type Database from 'better-sqlite3';
import { UNRECONCILED_REVIEWER_RUN } from '../validation/reviewer-run-repository.js';

/** Separate native aggregate usage from input/output telemetry; never invent a split. */
export function readComposableUsage(db: Database.Database, podId: string) {
  const review = db
    .prepare(`SELECT
    COALESCE(SUM(COALESCE(input_tokens,0)),0) AS inputTokens,
    COALESCE(SUM(COALESCE(output_tokens,0)),0) AS outputTokens,
    COALESCE(SUM(${UNRECONCILED_REVIEWER_RUN}),0) AS pending,
    COALESCE(SUM(usage_basis='unknown-accepted'),0) AS unknownAccepted
    FROM isolated_reviewer_runs WHERE pod_id=?`)
    .get(podId) as {
    inputTokens: number;
    outputTokens: number;
    pending: number;
    unknownAccepted: number;
  };
  const goal = db
    .prepare(`SELECT observed_tokens AS tokens, last_sequence AS sequence,
    execution_stopped AS stopped, native_session_id AS sessionId
    FROM retained_pod_goals WHERE pod_id=?`)
    .get(podId) as
    | {
        tokens: number;
        sequence: number;
        stopped: number;
        sessionId: string | null;
      }
    | undefined;
  return {
    reviewerInputTokens: review.inputTokens,
    reviewerOutputTokens: review.outputTokens,
    reviewerPending: review.pending > 0,
    reviewerUnknownAccepted: review.unknownAccepted,
    goalTokens: goal?.tokens ?? 0,
    goalObserved: !!goal && goal.sequence >= 0,
    goalUncertain: !!goal && (!goal.stopped || (!!goal.sessionId && goal.sequence < 0)),
  };
}
