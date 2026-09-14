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
        COALESCE(SUM(CASE WHEN state IN ('preparing','running','uncertain') OR cleanup!='clean' THEN 1 ELSE 0 END),0) AS pending
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
      const wholeBudget = task?.tokenBudget ?? budget.tokenBudget;
      if (task?.budgetCheck?.status === 'unavailable')
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

  interrupt(id: string): void {
    this.db
      .prepare(
        "UPDATE isolated_reviewer_runs SET state=CASE WHEN state='preparing' THEN 'failed' ELSE 'uncertain' END,updated_at=? WHERE id=? AND state IN ('preparing','running')",
      )
      .run(new Date().toISOString(), id);
  }
}
