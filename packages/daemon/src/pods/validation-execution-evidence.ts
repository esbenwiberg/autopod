import { createHash } from 'node:crypto';
import {
  AutopodError,
  type ValidationExecutionBinding,
  type ValidationResult,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import {
  requiresValidationFailureSettlement,
  requiresValidationSettlement,
} from './validation-recovery-policy.js';
export const validationResultHash = (result: ValidationResult) =>
  createHash('sha256').update(JSON.stringify(result)).digest('hex');
const validationRecoveryError = (
  message: string,
  code = 'VALIDATION_EXECUTION_UNVERIFIED',
): never => {
  throw new AutopodError(message, code, 409);
};
export interface UnsettledValidationDispatch {
  id: string;
  binding: ValidationExecutionBinding;
  resultHash: string | null;
  timestamp: string | null;
  published: boolean;
}
export function unsettledDispatches(
  db: Database.Database,
  taskId: string | null = null,
): UnsettledValidationDispatch[] {
  const rows = db
    .prepare(`SELECT d.id,d.binding,r.dispatch_id AS published_id,o.dispatch_id AS outcome_id,
      r.result_hash AS published_hash,o.result_hash AS outcome_hash,
      json_extract(r.result,'$.timestamp') AS published_timestamp,
      json_extract(o.result,'$.timestamp') AS outcome_timestamp,
      json_extract(r.result,'$.infrastructureFailure') AS published_failure,
      json_extract(o.result,'$.infrastructureFailure') AS outcome_failure
      FROM validation_dispatches d
      LEFT JOIN validation_dispatch_results r ON r.dispatch_id=d.id
      LEFT JOIN validation_dispatch_outcomes o ON o.dispatch_id=d.id
      WHERE (? IS NULL OR d.task_id=?) ORDER BY d.created_at,d.id`)
    .all(taskId, taskId) as Array<{
    id: string;
    binding: string;
    published_id: string | null;
    outcome_id: string | null;
    published_hash: string | null;
    outcome_hash: string | null;
    published_timestamp: string | null;
    outcome_timestamp: string | null;
    published_failure: string | null;
    outcome_failure: string | null;
  }>;
  return rows
    .filter(
      (row) =>
        !row.published_id ||
        requiresValidationFailureSettlement(
          row.published_failure ? JSON.parse(row.published_failure) : undefined,
        ) ||
        requiresValidationFailureSettlement(
          row.outcome_failure ? JSON.parse(row.outcome_failure) : undefined,
        ),
    )
    .map((row) => ({
      id: row.id,
      binding: JSON.parse(row.binding) as ValidationExecutionBinding,
      resultHash: row.published_hash ?? row.outcome_hash,
      timestamp: row.published_timestamp ?? row.outcome_timestamp,
      published: row.published_id !== null,
    }));
}
/** Provider transport fence: immutable dispatch custody survives changed pod pointers. */
export function assertValidationResourceSettled(db: Database.Database, containerId: string): void {
  const held = unsettledDispatches(db).find((row) => row.binding.containerId === containerId);
  if (held)
    validationRecoveryError(
      `Validation dispatch ${held.id} retains this exact execution resource; no wake or release is authorized.`,
    );
  // Old rows cannot establish retrospective ownership, but a current unknown
  // projection is still a reason to refuse mutation, never permission to delete.
  const legacy = db
    .prepare(
      'SELECT last_validation_result AS result FROM pods WHERE container_id=? AND last_validation_result IS NOT NULL',
    )
    .all(containerId) as Array<{ result: string }>;
  if (
    legacy.some((row) =>
      requiresValidationSettlement({ lastValidationResult: JSON.parse(row.result) }),
    )
  )
    validationRecoveryError('Validation termination is unverified for this retained resource.');
}

export function listValidationExecutionResourceIds(db: Database.Database): string[] {
  return unsettledDispatches(db).map((row) => row.binding.containerId);
}

export function assertTaskValidationSettled(db: Database.Database, podId: string): void {
  // Archived pods retain history but cannot acquire new execution membership.
  // Leave their established admission rejection to the owning ledger.
  const member = db.prepare('SELECT task_id FROM task_executions WHERE pod_id=?').get(podId) as
    | { task_id: string }
    | undefined;
  if (!member) return;
  const rows = db
    .prepare(`SELECT p.id,p.lifecycle_generation AS generation,p.last_validation_result AS result
        FROM pods p JOIN task_executions e ON e.pod_id=p.id WHERE e.task_id=? AND p.last_validation_result IS NOT NULL`)
    .all(member.task_id) as Array<{ id: string; generation: number; result: string }>;
  for (const row of rows) {
    const result = JSON.parse(row.result) as ValidationResult;
    if (requiresValidationSettlement({ lastValidationResult: result }))
      validationRecoveryError(
        `Validation execution termination is unverified for task owner ${row.id}. Inspect ap reconcile-validation ${row.id} --json before retry or repair.`,
        'VALIDATION_EXECUTION_UNVERIFIED',
      );
  }
  const unresolved = unsettledDispatches(db, member.task_id)[0];
  if (unresolved)
    validationRecoveryError(
      `Validation dispatch ${unresolved.id} for task owner ${unresolved.binding.podId} has no verified execution settlement. Inspect ap reconcile-validation ${unresolved.binding.podId} --json; missing result publication is not permission to repeat work.`,
      'VALIDATION_EXECUTION_UNVERIFIED',
    );
}
