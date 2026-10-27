import {
  AutopodError,
  type TerminationReconciliationReceipt,
  type TerminationReconciliationState,
  type UnverifiedTaskRun,
} from '@autopod/shared';
import type Database from 'better-sqlite3';

const CATEGORY = 'execution_termination_unverified';
function refuse(message: string): never {
  throw new AutopodError(message, 'TERMINATION_RECONCILIATION_REFUSED', 409);
}

/** Only dispatch-recorded, versioned sandbox ownership can support a deletion lookup. */
function resource(binding: string): UnverifiedTaskRun['resource'] {
  try {
    const parsed = JSON.parse(binding);
    if (
      parsed.version === 2 &&
      parsed.resource?.executionTarget === 'sandbox' &&
      typeof parsed.resource.containerId === 'string' &&
      // Azure sandbox IDs are UUIDs, not reusable names or current-pod guesses.
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        parsed.resource.containerId,
      )
    )
      return { containerId: parsed.resource.containerId, executionTarget: 'sandbox' };
  } catch {
    /* Legacy or malformed binding is not evidence. */
  }
  return null;
}

export interface TerminationReconciliationRepository {
  terminationReconciliations(podId: string): TerminationReconciliationState;
  reconcileUnverifiedRun(
    receipt: TerminationReconciliationReceipt,
  ): TerminationReconciliationReceipt;
}

export function createTerminationReconciliationRepository(
  db: Database.Database,
): TerminationReconciliationRepository {
  function terminationReconciliations(podId: string): TerminationReconciliationState {
    const task = db
      .prepare('SELECT task_id AS id FROM retained_task_executions WHERE pod_id=?')
      .get(podId) as { id: string } | undefined;
    if (!task) return refuse('Task execution identity unavailable');
    const pending = db
      .prepare(`SELECT r.id AS runId, r.pod_id AS podId,
      r.generation, r.cycle, r.binding FROM task_agent_runs r
      JOIN task_executions e ON e.pod_id=r.pod_id
      WHERE e.task_id=? AND r.ended_at IS NULL AND r.failure_category=?
      ORDER BY r.started_at,r.id`)
      .all(task.id, CATEGORY) as Array<Omit<UnverifiedTaskRun, 'resource'> & { binding: string }>;
    const receipts = db
      .prepare(`SELECT receipt FROM task_run_termination_reconciliations
      WHERE task_id=? ORDER BY reconciled_at,run_id`)
      .all(task.id) as { receipt: string }[];
    return {
      pending: pending.map(({ binding, ...run }) => ({ ...run, resource: resource(binding) })),
      receipts: receipts.map(
        ({ receipt }) => JSON.parse(receipt) as TerminationReconciliationReceipt,
      ),
    };
  }

  /** Caller supplies fresh daemon-owned backend evidence, never an operator assertion. */
  const reconcileUnverifiedRun = db.transaction((receipt: TerminationReconciliationReceipt) => {
    const existing = terminationReconciliations(receipt.podId).receipts.find(
      (row) => row.runId === receipt.runId,
    );
    if (existing) return existing;
    const age = Date.now() - Date.parse(receipt.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > 30_000 || receipt.proof !== 'sandbox-deleted')
      refuse('Fresh confirmed sandbox deletion is required');
    if (
      receipt.actor.type !== 'human' ||
      !receipt.actor.userId.trim() ||
      receipt.reason.trim().length < 10 ||
      receipt.reason.length > 4000
    )
      refuse('A human identity and meaningful reason are required');
    const run = terminationReconciliations(receipt.podId).pending.find(
      (row) => row.runId === receipt.runId && row.podId === receipt.podId,
    );
    const pod = db
      .prepare(`SELECT status,lifecycle_generation AS generation,
      execution_target AS target,container_id AS containerId FROM pods WHERE id=?`)
      .get(receipt.podId) as
      | {
          status: string;
          generation: number;
          target: string;
          containerId: string | null;
        }
      | undefined;
    const task = db
      .prepare('SELECT task_id AS id FROM task_executions WHERE pod_id=?')
      .get(receipt.podId) as { id: string } | undefined;
    if (
      !run?.resource ||
      !pod ||
      !task ||
      pod.status !== 'failed' ||
      run.generation !== receipt.generation ||
      run.cycle !== receipt.cycle ||
      pod.generation !== run.generation ||
      pod.target !== 'sandbox' ||
      task.id !== receipt.taskId ||
      (pod.containerId !== null && pod.containerId !== run.resource.containerId) ||
      run.resource.containerId !== receipt.resource.containerId ||
      receipt.resource.executionTarget !== 'sandbox'
    )
      refuse(
        'The exact failed run, lifecycle or recorded resource changed; refresh before recovery',
      );
    if (db.prepare('SELECT 1 FROM pod_goals WHERE pod_id=?').get(receipt.podId))
      refuse('Native Goals must use their existing process reconciliation controls');
    const saved = {
      ...receipt,
      reason: receipt.reason.trim(),
      reconciledAt: new Date().toISOString(),
    };
    db.prepare(`INSERT INTO task_run_termination_reconciliations
      (run_id,pod_id,task_id,receipt,reconciled_at) VALUES(?,?,?,?,?)`).run(
      saved.runId,
      saved.podId,
      saved.taskId,
      JSON.stringify(saved),
      saved.reconciledAt,
    );
    // Preserve the failed outcome and original category. ended_at records settlement,
    // NOT a measured process exit; retry timing/usage evidence remains untouched.
    db.prepare('UPDATE task_agent_runs SET ended_at=? WHERE id=? AND ended_at IS NULL').run(
      saved.reconciledAt,
      saved.runId,
    );
    // A failed cleanup may leave a stale current reference. Clear only the exact
    // confirmed-deleted resource; never delete a resource or touch a replacement.
    db.prepare(
      'UPDATE pods SET container_id=NULL WHERE id=? AND lifecycle_generation=? AND container_id=?',
    ).run(saved.podId, saved.generation, saved.resource.containerId);
    return saved;
  });
  return { terminationReconciliations, reconcileUnverifiedRun };
}
