import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import { createApprovalSourceRewriteRepository } from './approval-source-rewrite-repository.js';
import {
  assertRecoveryForkResourceAvailable,
  createRecoveryForkRepository,
} from './recovery-fork-repository.js';
import {
  checkpointHash,
  createRetainedCheckpointRepository,
} from './retained-checkpoint-repository.js';
import { sourceAdoptionError } from './source-adoption-identity.js';
import { assertStalledRecoveryAvailable } from './stalled-worker-recovery-repository.js';
import { assertValidationResourceReleasable } from './validation-execution-evidence.js';

export function assertSourceResourceReleasable(db: Database.Database, containerId: string): void {
  assertRecoveryForkResourceAvailable(db, containerId);
  assertValidationResourceReleasable(db, containerId);
  if (
    db
      .prepare(
        "SELECT 1 FROM source_adoptions WHERE json_extract(binding,'$.containerId')=? LIMIT 1",
      )
      .get(containerId)
  )
    sourceAdoptionError(
      'Original source/report resource remains in custody.',
      'SOURCE_CUSTODY_HELD',
    );
}
const owners = new WeakMap<Database.Database, AsyncLocalStorage<string>>();
export function sourceOwnerScope(db: Database.Database): AsyncLocalStorage<string> {
  let scope = owners.get(db);
  if (!scope) {
    scope = new AsyncLocalStorage<string>();
    owners.set(db, scope);
  }
  return scope;
}
/** Private async capability, scoped to this connection and ONE original pod/epoch. */
export function assertSourceAvailable(
  db: Database.Database,
  podId: string,
  owner = sourceOwnerScope(db).getStore(),
  initialInsert = false,
): void {
  createRecoveryForkRepository(db).assertOriginalAvailable(podId);
  if (!initialInsert) createRecoveryForkRepository(db).assertTaskExecutionAllowed(podId);
  assertStalledRecoveryAvailable(db, podId, true);
  createRetainedCheckpointRepository(db).assertAvailable(podId);
  const blocked = db
    .prepare(`SELECT s.id,s.pod_id AS podId,s.error,
    COALESCE(s.adopted_generation,json_extract(s.binding,'$.generation')) AS generation
    FROM source_adoptions s WHERE s.completed_at IS NULL AND
    (s.task_id=(SELECT task_id FROM task_executions WHERE pod_id=?) OR s.pod_id=?
    OR json_extract(s.binding,'$.containerId')=(SELECT container_id FROM pods WHERE id=?)
    OR json_extract(s.binding,'$.worktreePath')=(SELECT worktree_path FROM pods WHERE id=?))`)
    .all(podId, podId, podId, podId) as {
    id: string;
    podId: string;
    error: string | null;
    generation: number;
  }[];
  if (!blocked.length) return;
  const current = db
    .prepare('SELECT lifecycle_generation AS generation FROM pods WHERE id=?')
    .get(podId) as { generation: number } | undefined;
  if (
    blocked.some(
      (row) =>
        row.id !== owner ||
        row.podId !== podId ||
        row.error ||
        row.generation !== current?.generation,
    )
  )
    sourceAdoptionError(
      'Source adoption owns this task/resource. Observe its durable operation; no competing worker, validation or lifecycle mutation is admitted.',
      'SOURCE_ADOPTION_IN_PROGRESS',
    );
}
/** Delivery/release is NEVER implied by the private mutation capability or passing checks. */
export function assertSourceDeliveryAllowed(
  db: Database.Database,
  podId: string,
  initialInsert = false,
): void {
  createRecoveryForkRepository(db).assertOriginalAvailable(podId);
  if (!initialInsert) createRecoveryForkRepository(db).assertTaskExecutionAllowed(podId);
  const fork = createRecoveryForkRepository(db).child(podId);
  if (fork) {
    const row = db
      .prepare(
        'SELECT skip_validation,validation_waiver,validation_overrides,last_validation_result,readiness_review FROM pods WHERE id=?',
      )
      .get(podId) as
      | {
          skip_validation: number;
          validation_waiver: string | null;
          validation_overrides: string | null;
          last_validation_result: string | null;
          readiness_review: string | null;
        }
      | undefined;
    const result = row?.last_validation_result ? JSON.parse(row.last_validation_result) : null;
    const approval = row?.readiness_review ? JSON.parse(row.readiness_review).approval : null;
    const settled =
      fork.facts.worker &&
      db
        .prepare(
          "SELECT 1 FROM retained_task_agent_runs WHERE id=? AND ended_at IS NOT NULL AND outcome='completed' AND failure_category IS NOT 'execution_termination_unverified'",
        )
        .get(fork.facts.worker.runId);
    if (
      !settled ||
      row?.skip_validation ||
      row?.validation_waiver ||
      (row?.validation_overrides && JSON.parse(row.validation_overrides).length) ||
      result?.overall !== 'pass' ||
      approval?.actor?.type !== 'human' ||
      result?.taskReview?.status !== 'pass'
    )
      sourceAdoptionError(
        'Recovery fork requires settled coding, fresh enabled checks, independent review and separate human approval; waivers or inherited passes cannot authorize delivery.',
        'RECOVERY_FORK_DELIVERY_HELD',
      );
  }
  const recovery = createRetainedCheckpointRepository(db).latest(podId);
  if (recovery?.binding.continuation) {
    const current = db
      .prepare(
        'SELECT lifecycle_generation,status,worktree_path,last_validation_result,skip_validation,validation_waiver,validation_overrides FROM pods WHERE id=?',
      )
      .get(podId) as Record<string, unknown> | undefined;
    const result = current?.last_validation_result
      ? JSON.parse(String(current.last_validation_result))
      : null;
    // A later ordinary approval may prepare another isolated base rewrite. It
    // inherits the checked repair as predecessor; only its own fresh checked
    // selection can supersede CURRENT delivery proof. Historical repair holds stay.
    const successor =
      recovery.binding.approvalRewrite &&
      current &&
      createApprovalSourceRewriteRepository(db).isRepairSuccessor(
        { id: podId, lifecycleGeneration: Number(current.lifecycle_generation) },
        checkpointHash(result),
      );

    if (
      !recovery.checked ||
      recovery.checked.result.overall !== 'pass' ||
      result?.taskReview?.status !== 'pass' ||
      (!successor &&
        (recovery.checked.resultHash !== checkpointHash(result) ||
          current?.lifecycle_generation !== recovery.activated?.generation ||
          current?.worktree_path !== recovery.prepared?.worktree)) ||
      current?.skip_validation ||
      current?.validation_waiver ||
      (current?.validation_overrides && JSON.parse(String(current.validation_overrides)).length)
    )
      sourceAdoptionError(
        'Retained continuation requires current exact-source checks and independent review; no waiver or historical pass authorizes delivery.',
        'CONTINUATION_DELIVERY_HELD',
      );
  }
  if (recovery && !recovery.checked)
    sourceAdoptionError(
      'Checkpoint recovery grants checks only; no source publication or delivery is admitted.',
      'CHECKPOINT_CHECKS_ONLY',
    );
  if (
    db
      .prepare(
        'SELECT 1 FROM source_adoptions WHERE pod_id=? OR task_id=(SELECT task_id FROM task_executions WHERE pod_id=?) LIMIT 1',
      )
      .get(podId, podId)
  )
    sourceAdoptionError(
      'Source adoption authorizes checks only; original delivery constraints and source/report custody remain held.',
      'SOURCE_ADOPTION_DELIVERY_HELD',
    );
}
