import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  AutopodError,
  type CheckpointRecoveryRequest,
  type OperatorActor,
  type Pod,
  type ValidationResult,
} from '@autopod/shared';
export type { CheckpointRecoveryRequest } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { RetainedExecutionSelection } from '../configuration/retained-continuation-launch.js';
import type { prepareRetainedCheckpointWorkspace } from '../worktrees/retained-checkpoint-workspace.js';

export const checkpointHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Versioned provider namespace, never a new logical pod/task/request identity. */
export function checkpointResourceIdentity(podId: string, recoveryId: string, generation: number) {
  return `${podId}-retained-${checkpointHash(['docker-v1', recoveryId, generation]).slice(0, 24)}`;
}

/** Original and replacement bridges remain held until an explicit release protocol exists. */
export function retainedCheckpointNetworkIdentities(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT r.id,r.pod_id AS podId,e.evidence FROM retained_checkpoint_recoveries r
    LEFT JOIN retained_checkpoint_recovery_events e ON e.recovery_id=r.id AND e.kind='activated'`)
    .all() as { id: string; podId: string; evidence: string | null }[];
  const identities = new Set<string>();
  for (const row of rows) {
    identities.add(row.podId);
    if (row.evidence)
      identities.add(
        checkpointResourceIdentity(row.podId, row.id, JSON.parse(row.evidence).generation),
      );
  }
  return identities;
}

export function checkpointError(message: string, code = 'CHECKPOINT_RECOVERY_BLOCKED'): never {
  throw new AutopodError(message, code, 409);
}
export interface CheckpointRecoveryBinding {
  branch: string;
  head: string;
  repository: string;
  cycle: number;
  resultHash: string;
  configurationHash: string;
  /** Frozen rewrite ownership, not permission to use ordinary continuation. */
  approvalRewrite?: {
    id: string;
    dispatchId: string;
    evidenceHash: string;
    artifactsPath: string | null;
  };
  /** New explicit selection, not legacy unknown-execution reconciliation. */
  continuation?: {
    remoteHead?: string;
    prepareOnly: boolean;
    execution?: RetainedExecutionSelection;
  };
}
export type PreparedCheckpoint = Awaited<ReturnType<typeof prepareRetainedCheckpointWorkspace>> & {
  baseCommitSha?: string;
};
export interface CheckpointOutcomeRequest {
  expectedGeneration: number;
  expectedResultHash: string;
  expectedHead: string;
  reason: string;
}
export interface CheckpointOutcomeReceipt {
  requestHash: string;
  actor: OperatorActor;
  reason: string;
  generation: number;
  dispatchId: string;
  containerId: string;
  source: { head: string; tree: string; checkpoints: string[] };
  checked: NonNullable<CheckpointRecoveryRecord['checked']>;
  observedAt: string;
}
export interface CheckpointRecoveryRecord {
  id: string;
  podId: string;
  taskId: string;
  generation: number;
  containerId: string;
  resourceKey: string;
  worktreePath: string;
  requestHash: string;
  actor: OperatorActor;
  reason: string;
  binding: CheckpointRecoveryBinding;
  originalEvidence: { result: ValidationResult; preSubmitReview: Pod['preSubmitReview'] };
  createdAt: string;
  prepared: PreparedCheckpoint | null;
  selected: {
    head: string;
    tree: string;
    execution?: RetainedExecutionSelection;
    testBudget?: { seconds: number; reason: string; frozenTimeoutSeconds: number };
    actor: OperatorActor;
    reason: string;
    requestHash: string;
  } | null;
  activated: { generation: number } | null;
  checking: { generation: number } | null;
  checked: {
    source?: { head: string; tree: string };
    result: ValidationResult;
    resultHash: string;
    snapshot: { path: string; cycle: number; containerId: string } | null;
  } | null;
  blocked: { code: string } | null;
  reconciled: CheckpointOutcomeReceipt | null;
}
const scopes = new WeakMap<Database.Database, AsyncLocalStorage<string>>();
function scope(db: Database.Database) {
  let current = scopes.get(db);
  if (!current) {
    current = new AsyncLocalStorage<string>();
    scopes.set(db, current);
  }
  return current;
}

export function checkpointCredentialEpoch(db: Database.Database, podId: string): string | null {
  return (
    (
      db
        .prepare(
          'SELECT id FROM retained_checkpoint_recoveries WHERE pod_id=? ORDER BY generation DESC LIMIT 1',
        )
        .get(podId) as { id: string } | undefined
    )?.id ?? null
  );
}
export function retainedCheckpointResourceIds(db: Database.Database): string[] {
  return (
    db.prepare('SELECT container_id FROM retained_checkpoint_recoveries').all() as {
      container_id: string;
    }[]
  ).map((row) => row.container_id);
}
export function assertCheckpointResourceNotRetained(
  db: Database.Database,
  containerId: string,
): void {
  const retained = db
    .prepare('SELECT binding FROM retained_checkpoint_recoveries WHERE container_id=?')
    .get(containerId) as { binding: string } | undefined;
  if (retained)
    checkpointError(
      JSON.parse(retained.binding).continuation
        ? 'Original continuation resource retains source/report evidence. No wake, exec or release is authorized.'
        : 'Original checkpoint-recovery resource retains unknown execution/report evidence. No wake, exec or release is authorized.',
      'CHECKPOINT_ORIGINAL_RETAINED',
    );
}
/** An old wakeup remains unresolved and resource-retaining, but cannot own the new resource. */
export function checkpointDetachedWakeup(
  db: Database.Database,
  podId: string,
  resourceKey: string,
): boolean {
  return !!db
    .prepare(`SELECT 1 FROM retained_checkpoint_recoveries r
    JOIN retained_checkpoint_recovery_events e ON e.recovery_id=r.id AND e.kind='activated'
    JOIN pods p ON p.id=r.pod_id
    WHERE r.pod_id=? AND r.resource_key=? AND p.lifecycle_generation>r.generation
    AND (p.container_id IS NULL OR p.container_id<>r.container_id)
    AND (EXISTS(SELECT 1 FROM retained_checkpoint_recovery_events c WHERE c.recovery_id=r.id AND c.kind='checked')
      OR EXISTS(SELECT 1 FROM retained_checkpoint_outcome_reconciliations o WHERE o.recovery_id=r.id)
      OR p.worktree_path=json_extract((SELECT evidence FROM retained_checkpoint_recovery_events WHERE recovery_id=r.id AND kind='prepared'),'$.worktree'))`)
    .get(podId, resourceKey);
}

export function createRetainedCheckpointRepository(db: Database.Database) {
  function get(id: string): CheckpointRecoveryRecord | null {
    const raw = db
      .prepare(`SELECT id,pod_id AS podId,task_id AS taskId,generation,
      container_id AS containerId,resource_key AS resourceKey,worktree_path AS worktreePath,
      request_hash AS requestHash,actor,reason,binding,original_evidence AS originalEvidence,
      created_at AS createdAt FROM retained_checkpoint_recoveries WHERE id=?`)
      .get(id) as
      | (Omit<
          CheckpointRecoveryRecord,
          | 'actor'
          | 'binding'
          | 'originalEvidence'
          | 'prepared'
          | 'selected'
          | 'activated'
          | 'checking'
          | 'checked'
          | 'blocked'
          | 'reconciled'
        > & { actor: string; binding: string; originalEvidence: string })
      | undefined;
    if (!raw) return null;
    const events = db
      .prepare(
        'SELECT kind,evidence FROM retained_checkpoint_recovery_events WHERE recovery_id=? ORDER BY sequence',
      )
      .all(id) as { kind: string; evidence: string }[];
    const event = <T>(kind: string): T | null => {
      const found = events.find((entry) => entry.kind === kind);
      return found ? (JSON.parse(found.evidence) as T) : null;
    };
    const outcome = db
      .prepare(
        'SELECT evidence FROM retained_checkpoint_outcome_reconciliations WHERE recovery_id=?',
      )
      .get(id) as { evidence: string } | undefined;
    const reconciled: CheckpointOutcomeReceipt | null = outcome
      ? JSON.parse(outcome.evidence)
      : null;
    return {
      ...raw,
      actor: JSON.parse(raw.actor),
      binding: JSON.parse(raw.binding),
      originalEvidence: JSON.parse(raw.originalEvidence),
      prepared: event('prepared'),
      selected: (() => {
        const selection = db
          .prepare('SELECT evidence FROM retained_continuation_sources WHERE recovery_id=?')
          .get(id) as { evidence: string } | undefined;
        return selection ? JSON.parse(selection.evidence) : null;
      })(),
      activated: event('activated'),
      checking: event('checking'),
      checked: event<CheckpointRecoveryRecord['checked']>('checked') ?? reconciled?.checked ?? null,
      blocked: event('blocked'),
      reconciled,
    };
  }
  function latest(podId: string) {
    const id = checkpointCredentialEpoch(db, podId);
    return id ? get(id) : null;
  }
  function append(
    id: string,
    kind: 'prepared' | 'activated' | 'checking' | 'checked' | 'blocked',
    evidence: unknown,
  ) {
    const prior = get(id) ?? checkpointError('Missing checkpoint recovery');
    if (prior.blocked || prior.checked)
      checkpointError('Checkpoint recovery already stopped; observe its saved outcome');
    if (kind === 'prepared' && prior.prepared) checkpointError('Preparation cannot be replaced');
    if (kind === 'activated' && (!prior.prepared || prior.activated))
      checkpointError('Prepared checkpoint required for one activation');
    if (kind === 'checking' && (!prior.activated || prior.checking))
      checkpointError('Fresh checkpoint execution already entered or was not activated');
    if (kind === 'checked' && !prior.checking)
      checkpointError('Fresh checkpoint execution was not entered');
    db.prepare(
      'INSERT INTO retained_checkpoint_recovery_events(recovery_id,kind,evidence,created_at) VALUES(?,?,?,?)',
    ).run(id, kind, JSON.stringify(evidence), new Date().toISOString());
  }
  function assertAvailable(podId: string) {
    const rows = db
      .prepare(`SELECT r.id,r.pod_id AS podId FROM retained_checkpoint_recoveries r
      WHERE (r.pod_id=? OR r.task_id=(SELECT task_id FROM task_executions WHERE pod_id=?))
      AND NOT EXISTS(SELECT 1 FROM retained_checkpoint_recovery_events e WHERE e.recovery_id=r.id AND e.kind='checked')
      AND NOT EXISTS(SELECT 1 FROM retained_checkpoint_outcome_reconciliations o WHERE o.recovery_id=r.id)`)
      .all(podId, podId) as { id: string; podId: string }[];
    for (const row of rows) {
      const record = get(row.id) ?? checkpointError('Recovery custody record unavailable');
      const pod = db
        .prepare(
          'SELECT lifecycle_generation AS generation,worktree_path AS worktreePath,container_id AS containerId FROM pods WHERE id=?',
        )
        .get(podId) as
        | { generation: number; worktreePath: string; containerId: string | null }
        | undefined;
      if (
        scope(db).getStore() !== row.id ||
        row.podId !== podId ||
        record.blocked ||
        (record.activated &&
          (!pod ||
            pod.generation !== record.activated.generation ||
            pod.worktreePath !== record.prepared?.worktree ||
            pod.containerId === record.containerId))
      )
        checkpointError(
          'Checkpoint recovery owns this task; observe its durable operation instead of starting competing work.',
          'CHECKPOINT_RECOVERY_IN_PROGRESS',
        );
    }
  }
  return {
    get,
    latest,
    /** Only the owned, once-entered checks invocation can consume this allowance.
     * Existing started retry admissions are its durable one-shot use receipt.
     */
    testBudget(pod: Pod, frozenTimeoutMs: number | undefined) {
      const record = latest(pod.id);
      const budget = record?.selected?.testBudget;
      if (!record || !budget) return null;
      // A completed allowance must not contaminate later isolated approval rewrites.
      // The selected generation still fails closed on any attempted replay below.
      if (
        record.checked &&
        record.activated &&
        pod.lifecycleGeneration > record.activated.generation
      )
        return null;
      assertAvailable(pod.id);
      const task = db
        .prepare('SELECT task_id AS id FROM task_executions WHERE pod_id=?')
        .get(pod.id) as { id: string } | undefined;
      if (
        task?.id !== record.taskId ||
        scope(db).getStore() !== record.id ||
        !record.binding.continuation ||
        !record.checking ||
        record.checked ||
        record.blocked ||
        record.generation + 1 !== pod.lifecycleGeneration ||
        record.activated?.generation !== pod.lifecycleGeneration ||
        record.checking.generation !== pod.lifecycleGeneration ||
        record.prepared?.worktree !== pod.worktreePath ||
        pod.executionTarget !== 'local' ||
        pod.status !== 'validating' ||
        !pod.containerId ||
        pod.containerId === record.containerId ||
        !Number.isInteger(budget.seconds) ||
        !Number.isInteger(budget.frozenTimeoutSeconds) ||
        budget.frozenTimeoutSeconds < 1 ||
        budget.seconds > 3600 ||
        budget.seconds <= budget.frozenTimeoutSeconds ||
        budget.frozenTimeoutSeconds * 1000 !== frozenTimeoutMs ||
        budget.reason.trim().length < 10
      )
        checkpointError(
          'Retained test allowance no longer matches its owned source/generation/frozen timeout',
        );
      const used = db
        .prepare(`SELECT 1 FROM task_retry_attempts
        WHERE task_id=? AND pod_id=? AND generation=? AND stage='validation' AND started_at IS NOT NULL LIMIT 1`)
        .get(record.taskId, pod.id, pod.lifecycleGeneration);
      return { ...budget, recoveryId: record.id, used: Boolean(used) };
    },
    providerIdentity(podId: string, generation: number): string {
      const record = latest(podId);
      return record?.binding.continuation && record.activated?.generation === generation
        ? checkpointResourceIdentity(podId, record.id, generation)
        : podId;
    },
    append,
    activateExecution(id: string) {
      const record = get(id) ?? checkpointError('Recovery unavailable');
      const execution = record.selected?.execution ?? record.binding.continuation?.execution;
      if (
        !execution ||
        !record.prepared ||
        record.activated ||
        record.blocked ||
        record.checked ||
        scope(db).getStore() !== id ||
        !db.inTransaction ||
        !/^[a-f0-9]{64}$/.test(execution.digest) ||
        !/^[a-f0-9]{64}$/.test(execution.configurationHash ?? '')
      )
        checkpointError('Only owned atomic continuation activation can select execution');
      const changed = db
        .prepare(
          'UPDATE pods SET launch_config_digest=? WHERE id=? AND launch_config_digest=? AND lifecycle_generation=? AND container_id IS NULL AND worktree_path=? AND skip_agent=1 AND execution_target=?',
        )
        .run(
          execution.digest,
          record.podId,
          execution.parentDigest,
          record.generation + 1,
          record.prepared.worktree,
          execution.target,
        ).changes;
      if (changed !== 1)
        checkpointError('Original execution binding changed before atomic activation');
    },
    select(id: string, evidence: NonNullable<CheckpointRecoveryRecord['selected']>) {
      const record = get(id) ?? checkpointError('Recovery unavailable');
      if (
        !record.binding.continuation ||
        !record.prepared ||
        record.activated ||
        record.blocked ||
        record.checked ||
        scope(db).getStore() !== id ||
        !db.inTransaction ||
        evidence.actor.type !== 'human' ||
        !evidence.actor.userId.trim() ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.head) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.tree)
      )
        checkpointError('Only the owned prepared continuation may select an exact candidate');
      db.prepare('INSERT INTO retained_continuation_sources VALUES(?,?,?,?)').run(
        id,
        evidence.requestHash,
        JSON.stringify(evidence),
        new Date().toISOString(),
      );
    },
    assertAvailable,
    list(podId: string) {
      return (
        db
          .prepare(
            'SELECT id FROM retained_checkpoint_recoveries WHERE pod_id=? ORDER BY generation DESC LIMIT 50',
          )
          .all(podId) as { id: string }[]
      ).map((row) => get(row.id) ?? checkpointError('Recovery custody record unavailable'));
    },
    reconcile(id: string, receipt: CheckpointOutcomeReceipt) {
      const prior = get(id) ?? checkpointError('Checkpoint recovery unavailable');
      if (prior.reconciled) {
        if (prior.reconciled.requestHash !== receipt.requestHash)
          checkpointError(
            'Reconciliation already has a different request',
            'CHECKPOINT_RECOVERY_CONFLICT',
          );
        return prior;
      }
      if (
        prior.checked ||
        !prior.checking ||
        prior.blocked?.code !== 'CHECKPOINT_SOURCE_CHANGED' ||
        receipt.checked.result.overall !== 'fail' ||
        receipt.checked.snapshot !== null ||
        receipt.checked.resultHash !== checkpointHash(receipt.checked.result) ||
        receipt.actor.type !== 'human' ||
        receipt.generation !== prior.activated?.generation ||
        receipt.source.tree !== prior.prepared?.tree ||
        receipt.source.checkpoints.length === 0
      )
        checkpointError('Only an exact failed replacement outcome can be reconciled');
      const published = db
        .prepare(`SELECT 1 FROM validation_dispatches d
        JOIN validation_logical_publications p ON p.dispatch_id=d.id
        WHERE d.id=? AND d.pod_id=? AND d.task_id=? AND d.generation=?
          AND json_extract(d.binding,'$.containerId')=? AND p.result_hash=?`)
        .get(
          receipt.dispatchId,
          prior.podId,
          prior.taskId,
          receipt.generation,
          receipt.containerId,
          receipt.checked.resultHash,
        );
      if (!published) checkpointError('Exact logical validation publication required');
      db.prepare('INSERT INTO retained_checkpoint_outcome_reconciliations VALUES(?,?,?,?)').run(
        id,
        receipt.requestHash,
        JSON.stringify(receipt),
        receipt.observedAt,
      );
      return get(id) ?? checkpointError('Reconciliation was not retained');
    },
    owned<T>(id: string, operation: () => T): T {
      return scope(db).run(id, operation);
    },
    claim(input: {
      pod: Pod;
      taskId: string;
      resourceKey: string;
      request: CheckpointRecoveryRequest;
      actor: OperatorActor;
      binding: CheckpointRecoveryBinding;
      assertCurrent(): void;
    }): { record: CheckpointRecoveryRecord; acquired: boolean } {
      return db.transaction(() => {
        const { pod, request, actor } = input;
        if (
          actor.type !== 'human' ||
          !actor.userId.trim() ||
          !/^[a-zA-Z0-9-]{1,64}$/.test(request.id) ||
          request.reason.trim().length < 10 ||
          request.reason.length > 4000
        )
          checkpointError('Authenticated human, stable request ID and meaningful reason required');
        const requestHash = checkpointHash([pod.id, request, actor]);
        const prior = get(request.id);
        if (prior) {
          if (prior.requestHash !== requestHash || prior.podId !== pod.id)
            checkpointError(
              'Recovery request ID has different source or actor',
              'CHECKPOINT_RECOVERY_CONFLICT',
            );
          return { record: prior, acquired: false };
        }
        input.assertCurrent();
        assertAvailable(pod.id);
        if (
          request.expectedGeneration !== pod.lifecycleGeneration ||
          request.expectedResultHash !== checkpointHash(pod.lastValidationResult) ||
          input.binding.head !== request.checkpointHead ||
          input.binding.resultHash !== request.expectedResultHash
        )
          checkpointError(
            'Expected generation, result and checkpoint must match',
            'STALE_CHECKPOINT_RECOVERY',
          );
        if (!pod.containerId || !pod.worktreePath || !pod.lastValidationResult)
          checkpointError('Original source/resource/result required');
        const current = db
          .prepare(
            'SELECT lifecycle_generation,container_id,worktree_path,last_validation_result,status FROM pods WHERE id=?',
          )
          .get(pod.id) as Record<string, unknown> | undefined;
        if (
          !current ||
          current.lifecycle_generation !== request.expectedGeneration ||
          current.status !== pod.status ||
          current.container_id !== pod.containerId ||
          current.worktree_path !== pod.worktreePath ||
          current.last_validation_result !== JSON.stringify(pod.lastValidationResult)
        )
          checkpointError(
            'Original pod changed before recovery claim',
            'STALE_CHECKPOINT_RECOVERY',
          );
        db.prepare(
          'INSERT INTO retained_checkpoint_recoveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          request.id,
          pod.id,
          input.taskId,
          pod.lifecycleGeneration,
          pod.containerId,
          input.resourceKey,
          pod.worktreePath,
          requestHash,
          JSON.stringify(actor),
          request.reason.trim(),
          JSON.stringify(input.binding),
          JSON.stringify({
            result: pod.lastValidationResult,
            preSubmitReview: pod.preSubmitReview,
          }),
          new Date().toISOString(),
        );
        return {
          record: get(request.id) ?? checkpointError('Recovery claim was not retained'),
          acquired: true,
        };
      })();
    },
    assertWorkerAllowed(podId: string) {
      const current = latest(podId);
      if (current && !current.checked)
        checkpointError(
          'Checkpoint recovery admits fresh checks only, never a coding worker',
          'CHECKPOINT_CHECKS_ONLY',
        );
    },
  };
}
export type RetainedCheckpointRepository = ReturnType<typeof createRetainedCheckpointRepository>;
