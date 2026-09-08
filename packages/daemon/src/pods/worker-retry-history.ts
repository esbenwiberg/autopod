import { createHash } from 'node:crypto';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';

export const WORKER_RETRY_BACKOFFS_MS = [1_000, 5_000] as const;

export const unavailableWorkerInputs = {
  source: null,
  contract: null,
  commands: null,
  environment: null,
  implementation: null,
};

export function workerBindingHash(binding: {
  runtime: string;
  model: string;
  providerAccountId: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runtime: binding.runtime,
        model: binding.model,
        providerAccountId: binding.providerAccountId,
      }),
    )
    .digest('hex');
}

/** Import only recorded execution facts. Missing historical inputs remain null. */
export function retainWorkerRetryHistory(
  db: Database.Database,
  taskId: string,
  exceptRunId?: string,
): void {
  db.transaction(() => {
    const rows = db
      .prepare(`SELECT r.id, r.pod_id, r.generation, r.started_at, r.ended_at, r.outcome, r.failure_category,
    CASE WHEN length(CAST(r.binding AS BLOB)) <= 16384 THEN r.binding END AS binding,
    e.execution_id FROM retained_task_agent_runs r JOIN retained_task_executions e ON e.pod_id = r.pod_id
    WHERE e.task_id = ? AND r.id IS NOT ? AND NOT EXISTS (SELECT 1 FROM task_retry_attempts a WHERE a.id = r.id)
    ORDER BY r.started_at, r.id`)
      .all(taskId, exceptRunId ?? null) as Array<{
      id: string;
      pod_id: string;
      generation: number;
      started_at: string;
      ended_at: string | null;
      outcome: string | null;
      failure_category: string | null;
      binding: string | null;
      execution_id: string;
    }>;
    const insert =
      db.prepare(`INSERT INTO task_retry_attempts(id,task_id,pod_id,execution_id,generation,stage,identity,binding_hash,admitted_at,not_before,started_at,ended_at,outcome)
    VALUES (?,?,?,?,?,'worker',?,?,?,?,?,?,?)`);
    for (const row of rows) {
      let bindingHash = createHash('sha256')
        .update(`unavailable-worker-binding:${row.id}`)
        .digest('hex');
      try {
        const parsed = row.binding ? JSON.parse(row.binding) : null;
        if (
          parsed &&
          typeof parsed.runtime === 'string' &&
          typeof parsed.model === 'string' &&
          (parsed.providerAccountId === null || typeof parsed.providerAccountId === 'string')
        )
          bindingHash = workerBindingHash(parsed);
      } catch {
        /* No guessed binding for malformed legacy evidence. */
      }
      const outcome = !row.ended_at
        ? null
        : row.outcome === 'completed'
          ? 'pass'
          : row.outcome === 'paused' || row.outcome === 'stopped'
            ? 'cancelled'
            : row.failure_category === 'auth'
              ? 'nonretryable'
              : row.failure_category === 'transient' ||
                  row.failure_category === 'provider_unavailable'
                ? 'transient'
                : 'unknown';
      insert.run(
        row.id,
        taskId,
        row.pod_id,
        row.execution_id,
        row.generation,
        JSON.stringify(unavailableWorkerInputs),
        bindingHash,
        row.started_at,
        row.started_at,
        row.outcome === 'completed' ||
          ['auth', 'transient', 'provider_unavailable'].includes(row.failure_category ?? '')
          ? row.started_at
          : null,
        row.ended_at,
        outcome,
      );
    }
  })();
}

/** Unstarted retry reservations cannot supersede the failure they were allowed to retry. */
export function workerRetryFailure(
  db: Database.Database,
  runId: unknown,
): 'auth' | 'transient' | null {
  if (typeof runId !== 'string') return null;
  const read = db.prepare(`SELECT a.task_id, a.started_at, a.previous_failure_id,
    r.outcome AS run_outcome, r.failure_category
    FROM task_retry_attempts a LEFT JOIN retained_task_agent_runs r ON r.id = a.id
    WHERE a.id = ? AND a.stage = 'worker'`);
  const seen = new Set<string>();
  let taskId: string | undefined;
  let current: string | null = runId;
  while (current && seen.size < 128 && !seen.has(current)) {
    seen.add(current);
    const row = read.get(current) as
      | {
          task_id: string;
          started_at: string | null;
          previous_failure_id: string | null;
          run_outcome: string | null;
          failure_category: string | null;
        }
      | undefined;
    if (!row || (taskId !== undefined && row.task_id !== taskId)) break;
    taskId = row.task_id;
    if (row.run_outcome === 'failed') {
      if (row.failure_category === 'auth') return 'auth';
      if (row.failure_category === 'transient' || row.failure_category === 'provider_unavailable')
        return 'transient';
    }
    if (row.started_at !== null) return null;
    current = row.previous_failure_id;
    if (current === null) return null;
  }
  throw new AutopodError(
    'Worker retry ancestry requires reconciliation',
    'TASK_RETRY_RECONCILIATION_REQUIRED',
    409,
  );
}
