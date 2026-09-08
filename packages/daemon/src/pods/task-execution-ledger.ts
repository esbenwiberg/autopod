import { randomUUID } from 'node:crypto';
import { AutopodError, type TaskExecutionSummary } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { COST_PHASE_COLUMNS } from './cost-pod-projection.js';
import {
  appendCostEvidence,
  emptyCostEvidence,
  isAgentCostPhase,
  isHarnessCostPhase,
  reconcilePodCosts,
} from './cost-reconciliation.js';
import { hasUnansweredDecision } from './decision-admission.js';
import { readProviderUsage } from './provider-usage-projection.js';

export interface ExecutionBinding {
  runtime: string;
  model: string;
  providerAccountId: string | null;
}
export interface TaskExecutionLedger {
  register(podId: string): void;
  snapshot(podId: string): TaskExecutionSummary;
  beginRun(podId: string, generation: number, cycle: number, binding: ExecutionBinding): string;
  finishRun(
    id: string,
    outcome: 'completed' | 'failed' | 'paused' | 'stopped',
    category: string | null,
  ): void;
}
interface Membership {
  taskId: string;
  executionId: string;
  rootPodId: string;
}

export function createTaskExecutionLedger(db: Database.Database): TaskExecutionLedger {
  const membership = (podId: string): Membership | undefined =>
    db
      .prepare(`
    SELECT e.task_id AS taskId, e.execution_id AS executionId, t.root_pod_id AS rootPodId
    FROM task_executions e JOIN logical_tasks t ON t.id = e.task_id WHERE e.pod_id = ?
  `)
      .get(podId) as Membership | undefined;
  const register = db.transaction((podId: string) => {
    const seen = new Set<string>();
    const assign = (id: string): Membership => {
      const existing = membership(id);
      if (existing) return existing;
      if (seen.has(id))
        throw new AutopodError(
          'Cyclic task lineage requires reconciliation',
          'TASK_IDENTITY_UNAVAILABLE',
          409,
        );
      seen.add(id);
      const pod = db
        .prepare('SELECT linked_pod_id AS parent, created_at AS createdAt FROM pods WHERE id = ?')
        .get(id) as { parent: string | null; createdAt: string } | undefined;
      if (!pod)
        throw new AutopodError(
          'Missing task ancestor requires reconciliation',
          'TASK_IDENTITY_UNAVAILABLE',
          409,
        );
      const taskId = pod.parent ? assign(pod.parent).taskId : `task:${randomUUID()}`;
      if (!pod.parent)
        db.prepare('INSERT INTO logical_tasks (id, root_pod_id, created_at) VALUES (?, ?, ?)').run(
          taskId,
          id,
          pod.createdAt,
        );
      db.prepare(
        'INSERT INTO task_executions (pod_id, execution_id, task_id, parent_pod_id, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, `execution:${randomUUID()}`, taskId, pod.parent, pod.createdAt);
      return membership(id) as Membership;
    };
    assign(podId);
  });
  function snapshot(podId: string): TaskExecutionSummary {
    const identity = membership(podId);
    if (!identity)
      throw new AutopodError(
        'Task identity is unavailable; reconcile legacy lineage before execution',
        'TASK_IDENTITY_UNAVAILABLE',
        409,
      );
    const diagnostics: string[] = [];
    let recordedInputTokens = 0;
    let recordedOutputTokens = 0;
    let recordedCostUsd = 0;
    const costEvidence = emptyCostEvidence();
    let incompleteSpending = false;
    const rows = db
      .prepare(`SELECT p.id, p.input_tokens, p.output_tokens, p.cost_usd,
      ${COST_PHASE_COLUMNS}, p.token_telemetry_accuracy FROM task_executions e JOIN pods p ON p.id = e.pod_id
      WHERE e.task_id = ?`)
      .all(identity.taskId) as Array<{
      id: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      phase_token_usage: string | null;
      phase_token_usage_oversized: number | null;
      token_telemetry_accuracy: string;
    }>;
    const number = (value: unknown, id: string): number => {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
      diagnostics.push(`${id}: telemetry value unavailable`);
      incompleteSpending = true;
      return 0;
    };
    for (const row of rows) {
      const attempts = readProviderUsage(db, row.id);
      // The corrected append-only provider ledger is authoritative when present.
      // The pod row is a legacy fallback, never an additional bucket of provider spend.
      const agent =
        attempts.count > 0
          ? attempts
          : {
              inputTokens: row.input_tokens,
              outputTokens: row.output_tokens,
              costUsd: row.cost_usd,
            };
      const priorRuns = (
        db
          .prepare('SELECT COUNT(*) AS count FROM task_agent_runs WHERE pod_id = ?')
          .get(row.id) as {
          count: number;
        }
      ).count;
      // An opened zero-use provider segment can precede the first runtime event.
      // Existing runs, settled segments and positive usage demonstrate prior work.
      const priorWork =
        priorRuns > 0 ||
        (attempts.settledCount ?? 0) > 0 ||
        row.input_tokens > 0 ||
        row.output_tokens > 0 ||
        row.cost_usd > 0 ||
        (agent.inputTokens ?? 0) > 0 ||
        (agent.outputTokens ?? 0) > 0 ||
        (agent.costUsd ?? 0) > 0;
      recordedInputTokens += number(agent.inputTokens, row.id);
      recordedOutputTokens += number(agent.outputTokens, row.id);
      // Parse once for cost reconciliation; keep independent token admission diagnostics below.
      let rawPhases: unknown = null;
      try {
        rawPhases = row.phase_token_usage ? JSON.parse(row.phase_token_usage) : null;
      } catch {
        /* reported below */
      }
      const cost = reconcilePodCosts(
        {
          id: row.id,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          costUsd: row.cost_usd,
          phaseTokenUsage: rawPhases,
          recordDiagnostics: row.phase_token_usage_oversized
            ? [{ field: 'phase_token_usage', code: 'size_limit' }]
            : [],
        },
        attempts,
      );
      recordedCostUsd += cost.total;
      appendCostEvidence(costEvidence, cost.evidence);
      if (
        attempts.count > 0 &&
        (attempts.inputTokens !== row.input_tokens ||
          attempts.outputTokens !== row.output_tokens ||
          Math.abs((attempts.costUsd ?? 0) - row.cost_usd) > 1e-9)
      )
        diagnostics.push(
          `${row.id}: provider ledger differs from legacy pod totals; corrected ledger used`,
        );
      if (
        row.token_telemetry_accuracy !== 'complete' &&
        row.token_telemetry_accuracy !== 'repaired'
      ) {
        diagnostics.push(`${row.id}: agent telemetry incomplete`);
        if (priorWork) incompleteSpending = true;
      }
      if (row.phase_token_usage_oversized) {
        diagnostics.push(
          `${row.id}: phase telemetry exceeds the 64 KiB read limit; stored source preserved`,
        );
        incompleteSpending = true;
      }
      if (!row.phase_token_usage) {
        diagnostics.push(`${row.id}: phase telemetry unavailable`);
        if (priorWork) incompleteSpending = true;
        continue;
      }
      try {
        const phases: unknown = rawPhases;
        if (!phases || typeof phases !== 'object' || Array.isArray(phases))
          throw new Error('Invalid phases');
        for (const [name, value] of Object.entries(phases)) {
          // Agent phase buckets attribute the pod total; summing them again double counts it.
          if (isAgentCostPhase(name)) continue;
          if (!isHarnessCostPhase(name)) {
            diagnostics.push(`${row.id}: unrecognized phase telemetry excluded`);
            incompleteSpending = true;
            continue;
          }
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            diagnostics.push(`${row.id}: phase telemetry unreadable`);
            incompleteSpending = true;
            continue;
          }
          const phase = value as Record<string, unknown>;
          recordedInputTokens += number(phase.inputTokens, row.id);
          recordedOutputTokens += number(phase.outputTokens, row.id);
        }
      } catch {
        diagnostics.push(`${row.id}: phase telemetry unreadable`);
        incompleteSpending = true;
      }
    }
    const counts = db
      .prepare(`SELECT COUNT(*) AS agentRunCount,
      COALESCE(SUM(outcome = 'failed'), 0) AS failedRunCount,
      COALESCE(SUM(outcome = 'failed' AND failure_category IN ('transient','provider_unavailable')), 0) AS transientFailureCount
      FROM task_agent_runs r JOIN task_executions e ON e.pod_id = r.pod_id WHERE e.task_id = ?`)
      .get(identity.taskId) as Pick<
      TaskExecutionSummary,
      'agentRunCount' | 'failedRunCount' | 'transientFailureCount'
    >;
    const count = (table: 'provider_attempts' | 'validations'): number =>
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} r
      JOIN task_executions e ON e.pod_id = r.pod_id WHERE e.task_id = ?`)
          .get(identity.taskId) as { n: number }
      ).n;
    // Aggregate scalar receipt metadata only. Large/malformed legacy result
    // bodies are not parsed, and repeated observations never inflate receipts.
    const delivery = db
      .prepare(`WITH deliveries AS (
        SELECT r.id AS receiptId, COALESCE(
          (SELECT o.disposition FROM delivery_observations o WHERE o.receipt_id = r.id
            ORDER BY o.sequence DESC LIMIT 1), r.disposition) AS disposition
        FROM delivery_intents i LEFT JOIN delivery_receipts r ON r.intent_id = i.id
        WHERE i.task_id = ?
      ) SELECT COUNT(*) AS intentCount, COUNT(receiptId) AS receiptCount,
        COALESCE(SUM(receiptId IS NULL), 0) AS unresolvedCount,
        COALESCE(SUM(disposition = 'open'), 0) AS openCount,
        COALESCE(SUM(disposition = 'merged'), 0) AS mergedCount,
        COALESCE(SUM(disposition = 'closed'), 0) AS closedCount,
        COALESCE(SUM(receiptId IS NOT NULL AND
          (disposition IS NULL OR disposition NOT IN ('open','merged','closed'))), 0) AS unavailableCount
      FROM deliveries`)
      .get(identity.taskId) as {
      intentCount: number;
      receiptCount: number;
      unresolvedCount: number;
      openCount: number;
      mergedCount: number;
      closedCount: number;
      unavailableCount: number;
    };
    // Scalar-only aggregation: count each canonical PR once across linked executions.
    // A source-bound observation proves disposition, never who caused it.
    const merge = db
      .prepare(`WITH resources AS (
      SELECT i.pr_identity AS pr, MAX(
        EXISTS (SELECT 1 FROM merge_observations o WHERE o.intent_id = i.id AND o.disposition = 'merged')
        OR EXISTS (SELECT 1 FROM merge_disposition_observations o WHERE o.intent_id = i.id)
      ) AS merged,
      (SELECT o.disposition FROM merge_status_observations o JOIN merge_intents observed ON observed.id = o.intent_id
        WHERE observed.pr_identity = i.pr_identity AND observed.task_id = i.task_id ORDER BY o.sequence DESC LIMIT 1) AS lastStatus
      FROM merge_intents i WHERE i.task_id = ? GROUP BY i.pr_identity
    ) SELECT COUNT(*) AS prCount, COALESCE(SUM(merged), 0) AS mergedPrCount,
      COALESCE(SUM(NOT merged AND lastStatus = 'closed'), 0) AS closedPrCount,
      COALESCE(SUM(NOT merged AND COALESCE(lastStatus, 'open') != 'closed'), 0) AS unresolvedPrCount,
      COALESCE(SUM(merged AND NOT EXISTS (
        SELECT 1 FROM merge_attempts a JOIN merge_intents i ON i.id = a.intent_id WHERE i.pr_identity = resources.pr
      )), 0) AS mergedWithoutRecordedRequestCount,
      (SELECT COUNT(*) FROM merge_attempts a JOIN merge_intents i ON i.id = a.intent_id WHERE i.task_id = ?) AS requestCount
      FROM resources`)
      .get(identity.taskId, identity.taskId) as Pick<
      NonNullable<TaskExecutionSummary['merge']>,
      | 'prCount'
      | 'mergedPrCount'
      | 'closedPrCount'
      | 'unresolvedPrCount'
      | 'mergedWithoutRecordedRequestCount'
      | 'requestCount'
    >;
    const root = db
      .prepare('SELECT token_budget AS budget FROM pods WHERE id = ?')
      .get(identity.rootPodId) as { budget: number | null } | undefined;
    if (!root) diagnostics.push('Task budget source unavailable');
    const budgetCheck: NonNullable<TaskExecutionSummary['budgetCheck']> = !root
      ? { status: 'unavailable', reason: 'Task budget source unavailable.' }
      : root.budget === null || root.budget <= 0
        ? { status: 'unlimited', reason: 'No task token limit configured.' }
        : recordedInputTokens + recordedOutputTokens >= root.budget
          ? {
              status: 'exhausted',
              reason: 'Recorded task tokens have reached the configured limit.',
            }
          : incompleteSpending
            ? {
                status: 'unavailable',
                reason:
                  'Task token accounting incomplete; reconcile prior execution and phase telemetry before starting more budgeted work.',
              }
            : {
                status: 'below_recorded_limit',
                reason:
                  'Recorded usage is below the task limit. Future provider spending is not reserved.',
              };
    // Infrastructure billing is a separate missing measurement, never a fabricated zero.
    return {
      ...identity,
      ...counts,
      podCount: rows.length,
      tokenBudget: root?.budget ?? null,
      budgetCheck,
      providerAttemptCount: count('provider_attempts'),
      validationExecutionCount: count('validations'),
      delivery: {
        intentCount: delivery.intentCount,
        receiptCount: delivery.receiptCount,
        unresolvedCount: delivery.unresolvedCount,
        scope: 'durable-receipts-only',
        disposition: {
          openCount: delivery.openCount,
          mergedCount: delivery.mergedCount,
          closedCount: delivery.closedCount,
          unavailableCount: delivery.unavailableCount,
          basis: 'last-recorded',
          liveVerified: false,
        },
      },
      merge: {
        ...merge,
        scope: 'source-bound-journal-only',
        basis: 'last-recorded',
        liveVerified: false,
      },
      recordedInputTokens,
      recordedOutputTokens,
      recordedCostUsd,
      costEvidence,
      infrastructureCostUsd: null,
      telemetry: 'partial',
      diagnostics: [
        ...new Set([
          ...diagnostics,
          'Infrastructure cost unavailable',
          'Historical agent runs before the task ledger are not reconstructed',
        ]),
      ],
    };
  }
  return {
    register,
    snapshot,
    beginRun: db.transaction((podId, generation, cycle, binding) => {
      const encoded = JSON.stringify({
        runtime: binding.runtime,
        model: binding.model,
        providerAccountId: binding.providerAccountId,
      });
      const current = db
        .prepare('SELECT lifecycle_generation AS generation FROM pods WHERE id = ?')
        .get(podId) as { generation: number } | undefined;
      if (current?.generation !== generation)
        throw new Error('Stale lifecycle cannot start a task run');
      if (hasUnansweredDecision(db, podId))
        throw new AutopodError(
          'An unanswered human decision must be resolved before starting another worker.',
          'HUMAN_DECISION_PENDING',
          409,
        );
      const prior = db
        .prepare(
          'SELECT id, binding FROM task_agent_runs WHERE pod_id = ? AND generation = ? AND cycle = ?',
        )
        .get(podId, generation, cycle) as { id: string; binding: string } | undefined;
      if (prior) {
        if (prior.binding !== encoded)
          throw new Error('Execution binding cannot change for an existing run');
        return prior.id;
      }
      const task = snapshot(podId);
      if (task.diagnostics.includes('Task budget source unavailable'))
        throw new AutopodError(
          'Task budget source unavailable; reconcile the missing root pod',
          'TASK_BUDGET_UNAVAILABLE',
          409,
        );
      if (
        task.tokenBudget !== null &&
        task.tokenBudget > 0 &&
        task.recordedInputTokens + task.recordedOutputTokens >= task.tokenBudget
      )
        throw new AutopodError(
          `Task token budget exhausted across ${task.podCount} pods; reconcile or extend the task budget before agent execution`,
          'TASK_BUDGET_EXHAUSTED',
          409,
        );
      if (task.budgetCheck?.status === 'unavailable')
        throw new AutopodError(task.budgetCheck.reason, 'TASK_BUDGET_UNAVAILABLE', 409);
      const id = randomUUID();
      db.prepare(
        'INSERT INTO task_agent_runs (id, pod_id, generation, cycle, binding, started_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, podId, generation, cycle, encoded, new Date().toISOString());
      return id;
    }),
    finishRun: db.transaction((id, outcome, category) => {
      const prior = db
        .prepare('SELECT ended_at, outcome, failure_category FROM task_agent_runs WHERE id = ?')
        .get(id) as
        | { ended_at: string | null; outcome: string | null; failure_category: string | null }
        | undefined;
      if (!prior) throw new Error('Unknown task run');
      if (prior.ended_at) {
        if (prior.outcome !== outcome || prior.failure_category !== category)
          throw new Error('Task run already settled differently');
        return;
      }
      db.prepare(
        'UPDATE task_agent_runs SET ended_at = ?, outcome = ?, failure_category = ? WHERE id = ?',
      ).run(new Date().toISOString(), outcome, category, id);
    }),
  };
}
