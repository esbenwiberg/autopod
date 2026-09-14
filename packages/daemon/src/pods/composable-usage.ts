import type Database from 'better-sqlite3';

/** Separate native aggregate usage from input/output telemetry; never invent a split. */
export function readComposableUsage(db: Database.Database, podId: string) {
  const review = db
    .prepare(`SELECT
    COALESCE(SUM(COALESCE(input_tokens,0)),0) AS inputTokens,
    COALESCE(SUM(COALESCE(output_tokens,0)),0) AS outputTokens,
    COALESCE(SUM(state IN ('preparing','running','uncertain') OR cleanup!='clean'),0) AS pending
    FROM isolated_reviewer_runs WHERE pod_id=?`)
    .get(podId) as {
    inputTokens: number;
    outputTokens: number;
    pending: number;
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
    goalTokens: goal?.tokens ?? 0,
    goalObserved: !!goal && goal.sequence >= 0,
    goalUncertain: !!goal && (!goal.stopped || (!!goal.sessionId && goal.sequence < 0)),
  };
}
