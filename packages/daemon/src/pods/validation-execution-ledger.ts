import { createHash, randomUUID } from 'node:crypto';
import {
  AutopodError,
  type OperatorActor,
  type Pod,
  type ValidationExecutionBinding,
  type ValidationRecoveryBudgetReceipt,
  type ValidationResult,
  type ValidationSettlementReceipt,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { createSandboxWakeupJournal } from '../containers/sandbox-wakeup-journal.js';
import { assertNoValidationRecovery, createDeletionOwnership } from './deletion-ownership.js';
import { createExternalDeliveryRepository } from './external-delivery-repository.js';
import { createSourceAdoptionRepository } from './source-adoption-repository.js';
import {
  type UnsettledValidationDispatch,
  assertTaskValidationSettled,
  unsettledDispatches,
  validationResultHash,
} from './validation-execution-evidence.js';
import { assertValidationFinalContentSupported } from './validation-recovery-policy.js';
export {
  validationResultHash,
  listValidationExecutionResourceIds,
} from './validation-execution-evidence.js';

export const validationProviderBinding = (pod: Pod) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        pod.executionTarget,
        pod.runtime,
        pod.model,
        pod.providerIdSnapshot,
        pod.providerAccountIdSnapshot,
        pod.profileSnapshot,
      ]),
    )
    .digest('hex');
export const validationRecoveryError = (
  message: string,
  code = 'VALIDATION_RECOVERY_BLOCKED',
): never => {
  throw new AutopodError(message, code, 409);
};
export function assertRecoveryActor(actor: OperatorActor, reason: string): void {
  if (actor.type !== 'human' || !actor.userId.trim())
    throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
  if (reason.trim().length < 10 || reason.length > 4000)
    throw new AutopodError(
      'Provide a meaningful reason (10–4000 characters)',
      'INVALID_INPUT',
      400,
    );
}

/** Clearing a pod's mutable pointer must never orphan its unsettled validation resource. */
export interface ValidationRecoveryIntent {
  dispatchId: string;
  actor: OperatorActor;
  reason: string;
  preservation: { snapshot: string; checkpointCommit: string } | null;
  deletionStartedAt: string | null;
  receipt: ValidationSettlementReceipt | null;
}
export interface ValidationExecutionLedger {
  evidence(
    podId: string,
    dispatchId: string,
    resultHash: string,
  ): {
    binding: ValidationExecutionBinding;
    result: ValidationResult;
    preservation: ValidationRecoveryIntent['preservation'];
    evidenceKind: 'published-result' | 'outcome';
  };
  find(pod: Pod): {
    id: string;
    binding: ValidationExecutionBinding;
    intent: ValidationRecoveryIntent | null;
  } | null;
  intent(id: string): ValidationRecoveryIntent | null;
  unsettled(podId: string): UnsettledValidationDispatch | null;
  assertNoPendingRecovery(podId: string): void;
  assertNoActiveTaskExecution(podId: string): void;
  assertTaskSettled(podId: string): void;
  hasGoal(podId: string): boolean;
  isSettled(pod: Pod): boolean;
  dispatch(pod: Pod, admissionId: string, attempt: number, resourceScope?: string): string | null;
  recordResult(result: ValidationResult, dispatchId?: string): boolean;
  claimLogicalPublication(result: ValidationResult): boolean;
  recordOutcome(result: ValidationResult, dispatchId: string): void;
  assertResourceUnshared(podId: string, containerId: string): void;
  begin(pod: Pod, actor: OperatorActor, reason: string): ValidationRecoveryIntent;
  preservationPending(id: string): boolean;
  preservationAttempts(id: string): Array<{
    id: string;
    startedAt: string;
    settledAt: string | null;
    outcome: 'failed' | 'preserved' | null;
  }>;
  claimPreservation(id: string): string;
  finishPreservation(id: string, outcome: 'failed' | 'preserved'): void;
  preserve(id: string, preservation: NonNullable<ValidationRecoveryIntent['preservation']>): void;
  startDeletion(id: string): void;
  settle(pod: Pod, observedAt: string): ValidationSettlementReceipt;
  authorizeBudget(
    pod: Pod,
    seconds: number,
    reason: string,
    actor: OperatorActor,
  ): { id: string; seconds: number; createdAt: string; expiresAt: string };
  budget(pod: Pod): { id: string; seconds: number } | null;
  consumeBudget(id: string, dispatchId: string): void;
  budgets(podId: string): ValidationRecoveryBudgetReceipt[];
}
export function createValidationExecutionLedger(db: Database.Database): ValidationExecutionLedger {
  const taskId = (podId: string) => {
    const row = db.prepare('SELECT task_id AS id FROM task_executions WHERE pod_id=?').get(podId) as
      | { id: string }
      | undefined;
    return row?.id ?? validationRecoveryError('Task membership unavailable');
  };
  const intent = (id: string): ValidationRecoveryIntent | null => {
    const row = db
      .prepare('SELECT * FROM validation_recovery_intents WHERE dispatch_id=?')
      .get(id) as
      | {
          actor: string;
          reason: string;
          preservation: string | null;
          deletion_started_at: string | null;
          receipt: string | null;
        }
      | undefined;
    return row
      ? {
          dispatchId: id,
          actor: JSON.parse(row.actor),
          reason: row.reason,
          preservation: row.preservation ? JSON.parse(row.preservation) : null,
          deletionStartedAt: row.deletion_started_at ?? null,
          receipt: row.receipt ? JSON.parse(row.receipt) : null,
        }
      : null;
  };
  const find = (pod: Pod) => {
    if (!pod.lastValidationResult) return null;
    const row = db
      .prepare(`SELECT d.id, d.binding FROM validation_dispatches d
      JOIN validation_dispatch_results r ON r.dispatch_id=d.id
      WHERE d.pod_id=? AND d.task_id=? AND d.generation=? AND r.result_hash=?`)
      .get(
        pod.id,
        taskId(pod.id),
        pod.lifecycleGeneration,
        validationResultHash(pod.lastValidationResult),
      ) as { id: string; binding: string } | undefined;
    if (!row) return null;
    const binding = JSON.parse(row.binding) as ValidationExecutionBinding;
    const cycle =
      (
        db
          .prepare(
            'SELECT cycle FROM pod_finalizations WHERE pod_id=? AND generation=? ORDER BY cycle DESC LIMIT 1',
          )
          .get(pod.id, pod.lifecycleGeneration) as { cycle: number } | undefined
      )?.cycle ?? 0;
    if (
      binding.podId !== pod.id ||
      binding.taskId !== taskId(pod.id) ||
      binding.generation !== pod.lifecycleGeneration ||
      pod.lastValidationResult.podId !== pod.id ||
      (pod.lastValidationResult.executionDispatchId !== undefined &&
        pod.lastValidationResult.executionDispatchId !== row.id) ||
      binding.cycle !== cycle ||
      binding.providerBinding !== validationProviderBinding(pod) ||
      binding.worktreePath !== pod.worktreePath ||
      binding.attempt !== pod.lastValidationResult.attempt ||
      binding.executionTarget !== pod.executionTarget ||
      (pod.containerId !== null && pod.containerId !== binding.containerId)
    )
      return null;
    return { id: row.id, binding, intent: intent(row.id) };
  };
  const ledger: ValidationExecutionLedger = {
    evidence(podId, dispatchId, resultHash) {
      const row = db
        .prepare(`SELECT d.binding,r.result,i.preservation,'published-result' AS evidence_kind
        FROM validation_dispatches d JOIN validation_dispatch_results r ON r.dispatch_id=d.id
        LEFT JOIN validation_recovery_intents i ON i.dispatch_id=d.id
        WHERE d.pod_id=? AND d.id=? AND r.result_hash=?
        UNION ALL
        SELECT d.binding,o.result,NULL AS preservation,'outcome' AS evidence_kind
        FROM validation_dispatches d JOIN validation_dispatch_outcomes o ON o.dispatch_id=d.id
        WHERE d.pod_id=? AND d.id=? AND o.result_hash=?
        LIMIT 1`)
        .get(podId, dispatchId, resultHash, podId, dispatchId, resultHash) as
        | {
            binding: string;
            result: string;
            preservation: string | null;
            evidence_kind: 'published-result' | 'outcome';
          }
        | undefined;
      if (!row) throw new AutopodError('Exact validation evidence not found', 'NOT_FOUND', 404);
      return {
        binding: JSON.parse(row.binding),
        evidenceKind: row.evidence_kind,
        result: JSON.parse(row.result),
        preservation: row.preservation ? JSON.parse(row.preservation) : null,
      };
    },
    find,
    intent,
    unsettled(podId) {
      return unsettledDispatches(db, taskId(podId))[0] ?? null;
    },
    assertNoPendingRecovery(podId) {
      assertNoValidationRecovery(db, podId);
    },
    assertTaskSettled(podId: string): void {
      assertTaskValidationSettled(db, podId);
    },
    assertNoActiveTaskExecution(podId: string): void {
      if (
        db
          .prepare(
            'SELECT 1 FROM task_agent_runs r JOIN task_executions e ON e.pod_id=r.pod_id WHERE e.task_id=? AND r.ended_at IS NULL',
          )
          .get(taskId(podId)) ||
        db
          .prepare(
            "SELECT 1 FROM task_retry_attempts WHERE task_id=? AND stage='validation' AND ended_at IS NULL",
          )
          .get(taskId(podId))
      )
        validationRecoveryError('A task-wide execution/admission is active or unresolved');
    },
    hasGoal(podId: string): boolean {
      return !!db.prepare('SELECT 1 FROM pod_goals WHERE pod_id=?').get(podId);
    },
    assertResourceUnshared(podId: string, containerId: string): void {
      if (db.prepare('SELECT 1 FROM pods WHERE id<>? AND container_id=?').get(podId, containerId))
        validationRecoveryError(
          'Recorded sandbox is claimed by another pod; reconcile ownership before recovery',
        );
    },
    isSettled(_pod: Pod): boolean {
      return false;
    },
    dispatch(pod: Pod, admissionId: string, attempt: number, resourceScope?: string) {
      if (
        !resourceScope ||
        pod.executionTarget !== 'sandbox' ||
        !pod.containerId ||
        !pod.worktreePath ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pod.containerId)
      )
        return null;
      const admission = db
        .prepare(
          "SELECT 1 FROM task_retry_attempts WHERE id=? AND pod_id=? AND task_id=? AND generation=? AND stage='validation' AND started_at IS NOT NULL AND ended_at IS NULL",
        )
        .get(admissionId, pod.id, taskId(pod.id), pod.lifecycleGeneration);
      if (!admission)
        return validationRecoveryError('Exact started validation admission unavailable');
      const finalization = db
        .prepare(
          'SELECT cycle FROM pod_finalizations WHERE pod_id=? AND generation=? ORDER BY cycle DESC LIMIT 1',
        )
        .get(pod.id, pod.lifecycleGeneration) as { cycle: number } | undefined;
      const id = randomUUID();
      const binding: ValidationExecutionBinding = {
        podId: pod.id,
        taskId: taskId(pod.id),
        generation: pod.lifecycleGeneration,
        cycle: finalization?.cycle ?? 0,
        attempt,
        admissionId,
        executionTarget: 'sandbox',
        containerId: pod.containerId,
        resourceScope,
        worktreePath: pod.worktreePath,
        providerBinding: validationProviderBinding(pod),
      };
      db.prepare('INSERT INTO validation_dispatches VALUES(?,?,?,?,?,?,?,?)').run(
        id,
        pod.id,
        binding.taskId,
        binding.generation,
        binding.cycle,
        admissionId,
        JSON.stringify(binding),
        new Date().toISOString(),
      );
      return id;
    },
    claimLogicalPublication(result) {
      const id = result.executionDispatchId;
      if (!id) return true;
      const hash = validationResultHash(result);
      const evidence = db
        .prepare('SELECT result_hash FROM validation_dispatch_results WHERE dispatch_id=?')
        .get(id) as { result_hash: string } | undefined;
      if (!evidence || evidence.result_hash !== hash)
        return validationRecoveryError('Exact dispatch evidence must precede logical publication');
      return (
        db
          .prepare('INSERT OR IGNORE INTO validation_logical_publications VALUES(?,?,?)')
          .run(id, hash, new Date().toISOString()).changes === 1
      );
    },
    recordResult(result: ValidationResult, dispatchId = result.executionDispatchId) {
      if (!dispatchId) return true;
      const dispatch = db
        .prepare('SELECT binding FROM validation_dispatches WHERE id=?')
        .get(dispatchId) as { binding: string } | undefined;
      if (!dispatch) return validationRecoveryError('Validation dispatch unavailable');
      const binding = JSON.parse(dispatch.binding) as ValidationExecutionBinding;
      if (
        result.podId !== binding.podId ||
        result.attempt !== binding.attempt ||
        (result.executionDispatchId !== undefined && result.executionDispatchId !== dispatchId)
      )
        validationRecoveryError('Validation result does not match its exact dispatch identity');
      const prior = db
        .prepare('SELECT result_hash FROM validation_dispatch_results WHERE dispatch_id=?')
        .get(dispatchId) as { result_hash: string } | undefined;
      if (prior) {
        if (prior.result_hash !== validationResultHash(result))
          validationRecoveryError('Published validation result is immutable');
        return false;
      }
      db.prepare('INSERT INTO validation_dispatch_results VALUES(?,?,?)').run(
        dispatchId,
        validationResultHash(result),
        JSON.stringify(result),
      );
      return true;
    },
    recordOutcome(result: ValidationResult, dispatchId: string) {
      const row = db
        .prepare('SELECT binding FROM validation_dispatches WHERE id=?')
        .get(dispatchId) as { binding: string } | undefined;
      if (!row) return validationRecoveryError('Validation dispatch unavailable');
      const binding = JSON.parse(row.binding) as ValidationExecutionBinding;
      if (
        result.podId !== binding.podId ||
        result.attempt !== binding.attempt ||
        result.executionDispatchId !== dispatchId
      )
        validationRecoveryError('Validation outcome does not match its exact dispatch identity');
      db.prepare('INSERT INTO validation_dispatch_outcomes VALUES(?,?,?)').run(
        dispatchId,
        validationResultHash(result),
        JSON.stringify(result),
      );
    },
    begin: db.transaction((pod: Pod, actor: OperatorActor, reason: string) => {
      assertRecoveryActor(actor, reason);
      const dispatch =
        find(pod) ??
        validationRecoveryError(
          'No immutable validation-to-resource binding. Historical provenance and current containerId cannot establish ownership.',
          'VALIDATION_LEGACY_OWNERSHIP_UNAVAILABLE',
        );
      const existing = intent(dispatch.id);
      if (!existing) {
        // Admission and deletion ownership must be checked under the same write
        // transaction as the intent, including when another daemon owns the DB.
        createDeletionOwnership(db).assertTaskAvailable(pod.id);
        ledger.assertNoActiveTaskExecution(pod.id);
        const current = db
          .prepare(
            'SELECT lifecycle_generation, last_validation_result, status, container_id, worktree_path FROM pods WHERE id=?',
          )
          .get(pod.id) as
          | {
              lifecycle_generation: number;
              last_validation_result: string | null;
              status: string;
              container_id: string | null;
              worktree_path: string | null;
            }
          | undefined;
        if (
          !current ||
          current.lifecycle_generation !== pod.lifecycleGeneration ||
          current.last_validation_result !== JSON.stringify(pod.lastValidationResult) ||
          current.container_id !== pod.containerId ||
          current.worktree_path !== pod.worktreePath ||
          !['failed', 'review_required'].includes(current.status) ||
          ledger.hasGoal(pod.id)
        )
          validationRecoveryError('Pod changed before recovery acquired task ownership');
        const source = createSourceAdoptionRepository(db);
        source.assertAvailable(pod.id, '');
        source.assertControlPlaneSettled(pod.id);
        source.assertReleasable(dispatch.binding.containerId);
        const wakeups = createSandboxWakeupJournal(db);
        wakeups.assertPodReleasable(pod.id);
        wakeups.assertReleasable(dispatch.binding.containerId);
        createExternalDeliveryRepository(db).assertReleasable(dispatch.binding.containerId);
        db.prepare(
          'INSERT INTO validation_recovery_intents(dispatch_id,pod_id,task_id,actor,reason,created_at) VALUES(?,?,?,?,?,?)',
        ).run(
          dispatch.id,
          pod.id,
          dispatch.binding.taskId,
          JSON.stringify(actor),
          reason.trim(),
          new Date().toISOString(),
        );
      }
      return intent(dispatch.id) ?? validationRecoveryError('Recovery intent unavailable');
    }),
    preservationAttempts(id: string) {
      return db
        .prepare(
          'SELECT id,started_at AS startedAt,settled_at AS settledAt,outcome FROM validation_preservation_attempts WHERE dispatch_id=? ORDER BY started_at,id',
        )
        .all(id) as Array<{
        id: string;
        startedAt: string;
        settledAt: string | null;
        outcome: 'failed' | 'preserved' | null;
      }>;
    },
    preservationPending(id: string): boolean {
      return !!db
        .prepare(
          'SELECT 1 FROM validation_preservation_attempts WHERE dispatch_id=? AND settled_at IS NULL',
        )
        .get(id);
    },
    claimPreservation: db.transaction((id: string) => {
      if (ledger.preservationPending(id))
        validationRecoveryError(
          'Preservation is active or interrupted without a completed snapshot receipt. Retain the sandbox; investigate the exact saved preservation attempt before further recovery.',
          'VALIDATION_PRESERVATION_UNVERIFIED',
        );
      const attempt = randomUUID();
      db.prepare('INSERT INTO validation_preservation_attempts VALUES(?,?,?,NULL,NULL)').run(
        attempt,
        id,
        new Date().toISOString(),
      );
      return attempt;
    }),
    finishPreservation(id: string, outcome: 'failed' | 'preserved') {
      db.prepare(
        'UPDATE validation_preservation_attempts SET settled_at=?,outcome=? WHERE id=? AND settled_at IS NULL',
      ).run(new Date().toISOString(), outcome, id);
    },
    preserve(id: string, preservation: NonNullable<ValidationRecoveryIntent['preservation']>) {
      db.prepare(
        'UPDATE validation_recovery_intents SET preservation=? WHERE dispatch_id=? AND preservation IS NULL',
      ).run(JSON.stringify(preservation), id);
    },
    startDeletion(_id: string) {
      assertValidationFinalContentSupported();
    },
    settle(_pod: Pod, _observedAt: string) {
      return assertValidationFinalContentSupported();
    },
    authorizeBudget: db.transaction(
      (pod: Pod, seconds: number, reason: string, actor: OperatorActor) => {
        assertRecoveryActor(actor, reason);
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600)
          return validationRecoveryError('Finite test budget must be 1–3600 seconds');
        if (!pod.lastValidationResult || pod.lastValidationResult.overall !== 'fail')
          return validationRecoveryError('Current failed validation required');
        const hash = validationResultHash(pod.lastValidationResult);
        const existing = db
          .prepare(
            'SELECT * FROM validation_recovery_budgets WHERE pod_id=? AND result_hash=? AND dispatch_id IS NULL AND expires_at>?',
          )
          .get(pod.id, hash, new Date().toISOString()) as Record<string, unknown> | undefined;
        if (existing) {
          if (
            existing.seconds !== seconds ||
            existing.reason !== reason.trim() ||
            existing.actor !== JSON.stringify(actor)
          )
            return validationRecoveryError('An unconsumed budget already exists for this failure');
          return {
            id: String(existing.id),
            seconds: Number(existing.seconds),
            createdAt: String(existing.created_at),
            expiresAt: String(existing.expires_at),
          };
        }
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 3600000).toISOString();
        db.prepare(
          'INSERT INTO validation_recovery_budgets VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)',
        ).run(
          id,
          pod.id,
          taskId(pod.id),
          pod.lifecycleGeneration,
          hash,
          validationProviderBinding(pod),
          seconds,
          JSON.stringify(actor),
          reason.trim(),
          createdAt,
          expiresAt,
        );
        return { id, seconds, createdAt, expiresAt };
      },
    ),
    budget(pod: Pod): { id: string; seconds: number } | null {
      // Rework clears lastValidationResult only in the immediately following
      // generation. A different completed result must never inherit this grant.
      const resultHash = pod.lastValidationResult
        ? validationResultHash(pod.lastValidationResult)
        : null;
      return (
        (db
          .prepare(
            `SELECT id,seconds FROM validation_recovery_budgets b WHERE pod_id=? AND task_id=?
            AND generation IN (?,?) AND binding=? AND dispatch_id IS NULL AND expires_at>?
            AND (result_hash=? OR (? IS NULL AND generation=?))
            ORDER BY created_at DESC LIMIT 1`,
          )
          .get(
            pod.id,
            taskId(pod.id),
            pod.lifecycleGeneration,
            pod.lifecycleGeneration - 1,
            validationProviderBinding(pod),
            new Date().toISOString(),
            resultHash,
            resultHash,
            pod.lifecycleGeneration - 1,
          ) as { id: string; seconds: number } | undefined) ?? null
      );
    },
    budgets(podId: string): ValidationRecoveryBudgetReceipt[] {
      const rows = db
        .prepare(
          'SELECT * FROM validation_recovery_budgets WHERE pod_id=? ORDER BY created_at DESC LIMIT 100',
        )
        .all(podId) as Array<{
        id: string;
        generation: number;
        result_hash: string;
        seconds: number;
        actor: string;
        reason: string;
        created_at: string;
        expires_at: string;
        dispatch_id: string | null;
      }>;
      return rows.map((row) => ({
        id: row.id,
        generation: row.generation,
        resultHash: row.result_hash,
        seconds: row.seconds,
        actor: JSON.parse(row.actor),
        reason: row.reason,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        consumedByDispatchId: row.dispatch_id,
      }));
    },
    consumeBudget(id: string, dispatchId: string) {
      if (
        !db
          .prepare(
            'UPDATE validation_recovery_budgets SET dispatch_id=? WHERE id=? AND dispatch_id IS NULL AND expires_at>?',
          )
          .run(dispatchId, id, new Date().toISOString()).changes
      )
        validationRecoveryError('Recovery budget expired or consumed before dispatch');
    },
  };
  return ledger;
}
