import type { AgentRoute, EffectiveLaunchConfig, Pod, TaskExecutionSummary } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationError } from '../configuration/configuration-store.js';
import type { CodexReviewTokenUsage } from './review-codex-runner.js';

export interface ReviewerRunRow {
  id: string;
  pod_id: string;
  execution_target: 'local' | 'sandbox';
  container_id: string | null;
}

export interface ReviewerRunRecord {
  id: string;
  podId: string;
  executionTarget: 'local' | 'sandbox';
  containerId: string | null;
  runtime: string;
  model: string;
  state: 'preparing' | 'running' | 'completed' | 'failed' | 'uncertain';
  cleanup: 'pending' | 'clean' | 'uncertain';
  failureKind: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
  updatedAt: string;
  reconciledAt: string | null;
  reconciledBy: string | null;
  reconciliationNote: string | null;
  usageBasis: 'operator-reported' | 'unknown-accepted' | null;
  /** True while this run blocks new reviewers and task-budget accounting. */
  requiresReconciliation: boolean;
}

type ReviewerRunSqlRecord = Omit<ReviewerRunRecord, 'requiresReconciliation'> & {
  requiresReconciliation: number;
};

/** A run blocks new reviewers until it is finished, cleaned and its usage is known or accepted. */
export const UNRECONCILED_REVIEWER_RUN = `(state IN ('preparing','running')
  OR (state='uncertain' AND reconciled_at IS NULL) OR cleanup!='clean')`;

const RECORD_COLUMNS = `id, pod_id AS podId, execution_target AS executionTarget,
  container_id AS containerId, runtime, model,
  state, cleanup, failure_kind AS failureKind, input_tokens AS inputTokens,
  output_tokens AS outputTokens, created_at AS createdAt, updated_at AS updatedAt,
  reconciled_at AS reconciledAt, reconciled_by AS reconciledBy,
  reconciliation_note AS reconciliationNote, usage_basis AS usageBasis,
  ${UNRECONCILED_REVIEWER_RUN} AS requiresReconciliation`;

export function hasMeasuredReviewerUsage(
  usage?: CodexReviewTokenUsage,
): usage is CodexReviewTokenUsage {
  return (
    !!usage &&
    usage.complete !== false &&
    Number.isSafeInteger(usage.inputTokens) &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.inputTokens >= 0 &&
    usage.outputTokens >= 0
  );
}
export class ReviewerRunRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly taskUsage?: (podId: string) => TaskExecutionSummary,
  ) {}

  reserve(
    id: string,
    pod: Pod,
    config: EffectiveLaunchConfig,
    route: AgentRoute,
    attempt?: { requestId: string; ordinal: number },
  ): void {
    this.db.transaction(() => {
      // Serialize review against the pod budget. Unknown usage must be reconciled before retry.
      const totals = this.db
        .prepare(`SELECT
        COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)),0) AS tokens,
        COALESCE(SUM(CASE WHEN ${UNRECONCILED_REVIEWER_RUN} THEN 1 ELSE 0 END),0) AS pending
        FROM isolated_reviewer_runs WHERE pod_id=?`)
        .get(pod.id) as { tokens: number; pending: number };
      if (totals.pending)
        configurationError(
          'A previous reviewer is active or requires reconciliation',
          'REVIEWER_RECONCILIATION_REQUIRED',
          409,
        );
      const budget = config.workflow;
      const task = this.taskUsage?.(pod.id);
      const total = task
        ? (task.recordedTotalTokens ?? task.recordedInputTokens + task.recordedOutputTokens)
        : pod.inputTokens + pod.outputTokens + totals.tokens;
      const wholeBudget = task ? task.tokenBudget : budget.tokenBudget;
      if (
        task?.budgetCheck?.status === 'unavailable' &&
        (wholeBudget === null || budget.tokenBudgetPolicy === 'hard')
      )
        configurationError(
          'Reconcile task usage before starting a reviewer',
          'REVIEWER_RECONCILIATION_REQUIRED',
          409,
        );
      if (
        (budget.reviewerTokenBudget !== null && totals.tokens >= budget.reviewerTokenBudget) ||
        (budget.tokenBudgetPolicy === 'hard' && wholeBudget !== null && total >= wholeBudget)
      )
        configurationError(
          'The pod has exhausted its review budget',
          'REVIEWER_BUDGET_EXHAUSTED',
          409,
        );
      const now = new Date().toISOString();
      this.db
        .prepare(`INSERT INTO isolated_reviewer_runs
        (id,pod_id,lifecycle_generation,configuration_digest,account_id,runtime,model,execution_target,state,cleanup,created_at,updated_at,request_id,ordinal)
        VALUES(?,?,?,?,?,?,?,?,'preparing','pending',?,?,?,?)`)
        .run(
          id,
          pod.id,
          pod.lifecycleGeneration,
          config.digest,
          route.providerAccountId,
          route.runtime,
          route.model,
          config.execution.target,
          now,
          now,
          attempt?.requestId ?? null,
          attempt?.ordinal ?? null,
        );
    })();
  }

  attach(id: string, containerId: string): void {
    if (
      this.db
        .prepare(
          "UPDATE isolated_reviewer_runs SET container_id=?,updated_at=? WHERE id=? AND container_id IS NULL AND cleanup!='clean'",
        )
        .run(containerId, new Date().toISOString(), id).changes !== 1
    )
      configurationError(
        'Reviewer allocation no longer owns this run',
        'REVIEWER_RUN_CHANGED',
        409,
      );
  }

  running(id: string): void {
    if (
      this.db
        .prepare(
          "UPDATE isolated_reviewer_runs SET state='running',updated_at=? WHERE id=? AND state='preparing' AND container_id IS NOT NULL",
        )
        .run(new Date().toISOString(), id).changes !== 1
    )
      configurationError('Reviewer launch no longer owns this run', 'REVIEWER_RUN_CHANGED', 409);
  }

  finish(
    id: string,
    dispatched: boolean,
    completed: boolean,
    usage?: CodexReviewTokenUsage,
    failureKind?: string,
  ): void {
    const measured = hasMeasuredReviewerUsage(usage);
    const state = dispatched && !measured ? 'uncertain' : completed ? 'completed' : 'failed';
    this.db
      .prepare(
        'UPDATE isolated_reviewer_runs SET state=?,input_tokens=?,output_tokens=?,failure_kind=?,updated_at=? WHERE id=?',
      )
      .run(
        state,
        measured ? usage.inputTokens : null,
        measured ? usage.outputTokens : null,
        failureKind ?? null,
        new Date().toISOString(),
        id,
      );
  }

  cleaned(id: string, confirmed: boolean): void {
    this.db
      .prepare('UPDATE isolated_reviewer_runs SET cleanup=?,updated_at=? WHERE id=?')
      .run(confirmed ? 'clean' : 'uncertain', new Date().toISOString(), id);
  }

  pending(): ReviewerRunRow[] {
    return this.db
      .prepare(
        "SELECT id,pod_id,execution_target,container_id FROM isolated_reviewer_runs WHERE cleanup!='clean'",
      )
      .all() as ReviewerRunRow[];
  }

  list(podId: string): ReviewerRunRecord[] {
    return (
      this.db
        .prepare(
          `SELECT ${RECORD_COLUMNS} FROM isolated_reviewer_runs WHERE pod_id=? ORDER BY created_at DESC, id`,
        )
        .all(podId) as ReviewerRunSqlRecord[]
    ).map((row) => ({ ...row, requiresReconciliation: !!row.requiresReconciliation }));
  }

  get(podId: string, runId: string): ReviewerRunRecord | null {
    const row = this.db
      .prepare(`SELECT ${RECORD_COLUMNS} FROM isolated_reviewer_runs WHERE pod_id=? AND id=?`)
      .get(podId, runId) as ReviewerRunSqlRecord | undefined;
    return row ? { ...row, requiresReconciliation: !!row.requiresReconciliation } : null;
  }

  /** Why an immediate re-review would be refused, or null when one may start. */
  retryBlocker(podId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM isolated_reviewer_runs WHERE pod_id=? AND ${UNRECONCILED_REVIEWER_RUN} ORDER BY created_at DESC LIMIT 1`,
      )
      .get(podId) as { id: string } | undefined;
    return row ? `reviewer run ${row.id} requires reconciliation` : null;
  }

  /**
   * Close an unmeasured run. Without usage the spend is accepted as unknown, regardless of
   * budget policy: the operator explicitly takes responsibility for the unrecorded tokens.
   */
  reconcile(
    podId: string,
    runId: string,
    actorId: string,
    note: string,
    usage?: { inputTokens: number; outputTokens: number },
  ): ReviewerRunRecord {
    if (
      usage &&
      ![usage.inputTokens, usage.outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      configurationError('Reviewer usage must be non-negative integers', 'INVALID_USAGE', 400);
    return this.db.transaction(() => {
      const run = this.get(podId, runId);
      if (!run) configurationError('Reviewer run not found', 'REVIEWER_RUN_NOT_FOUND', 404);
      if (run.state === 'preparing' || run.state === 'running')
        configurationError('Reviewer run is still active', 'REVIEWER_RUN_ACTIVE', 409);
      if (run.cleanup !== 'clean')
        configurationError(
          'Reviewer cleanup is not confirmed',
          'REVIEWER_CLEANUP_UNCONFIRMED',
          409,
        );
      if (run.state !== 'uncertain' || run.reconciledAt)
        configurationError(
          'Reviewer run does not require reconciliation',
          'REVIEWER_RUN_NOT_UNCERTAIN',
          409,
        );
      const changed = this.db
        .prepare(`UPDATE isolated_reviewer_runs SET input_tokens=?,output_tokens=?,usage_basis=?,
          reconciled_at=?,reconciled_by=?,reconciliation_note=?,updated_at=?
          WHERE id=? AND pod_id=? AND state='uncertain' AND cleanup='clean' AND reconciled_at IS NULL`)
        .run(
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          usage ? 'operator-reported' : 'unknown-accepted',
          new Date().toISOString(),
          actorId,
          note,
          new Date().toISOString(),
          runId,
          podId,
        ).changes;
      if (changed !== 1)
        configurationError('Reviewer run changed concurrently', 'REVIEWER_RUN_CHANGED', 409);
      return this.get(podId, runId) as ReviewerRunRecord;
    })();
  }

  interrupt(id: string): void {
    this.db
      .prepare(
        "UPDATE isolated_reviewer_runs SET state=CASE WHEN state='preparing' THEN 'failed' ELSE 'uncertain' END,updated_at=? WHERE id=? AND state IN ('preparing','running')",
      )
      .run(new Date().toISOString(), id);
  }
}
