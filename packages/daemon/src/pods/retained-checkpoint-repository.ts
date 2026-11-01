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
import type { prepareRetainedCheckpointWorkspace } from '../worktrees/retained-checkpoint-workspace.js';

export const checkpointHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  /** Human-authorized setup correction for this generation, not a frozen preset rewrite. */
  setupCommand?: string;
}
export type PreparedCheckpoint = Awaited<ReturnType<typeof prepareRetainedCheckpointWorkspace>>;
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
  activated: { generation: number } | null;
  checking: { generation: number } | null;
  checked: {
    result: ValidationResult;
    resultHash: string;
    source?: { head: string; selectedHead: string; tree: string; checkpoints: string[] };
    resolution?: { id: string; requestHash: string; actor: OperatorActor; reason: string };
    snapshot: { path: string; cycle: number; containerId: string } | null;
  } | null;
  blocked: { code: string } | null;
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
  if (
    db.prepare('SELECT 1 FROM retained_checkpoint_recoveries WHERE container_id=?').get(containerId)
  )
    checkpointError(
      'Original checkpoint-recovery resource retains unknown execution/report evidence. No wake, exec or release is authorized.',
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
          | 'activated'
          | 'checking'
          | 'checked'
          | 'blocked'
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
    return {
      ...raw,
      actor: JSON.parse(raw.actor),
      binding: JSON.parse(raw.binding),
      originalEvidence: JSON.parse(raw.originalEvidence),
      prepared: event('prepared'),
      activated: event('activated'),
      checking: event('checking'),
      checked: event('checked'),
      blocked: event('blocked'),
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
      AND NOT EXISTS(SELECT 1 FROM retained_checkpoint_recovery_events e WHERE e.recovery_id=r.id AND e.kind='checked')`)
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
    append,
    assertAvailable,
    resolveFailed(id: string, evidence: NonNullable<CheckpointRecoveryRecord['checked']>): void {
      db.transaction(() => {
        const record = get(id) ?? checkpointError('Recovery unavailable');
        const resolution = evidence.resolution;
        if (
          record.checked ||
          record.blocked?.code !== 'CHECKPOINT_SOURCE_CHANGED' ||
          !record.checking ||
          !record.activated ||
          !record.prepared ||
          !resolution ||
          resolution.actor.type !== 'human' ||
          !resolution.actor.userId.trim() ||
          evidence.result.overall !== 'fail' ||
          evidence.snapshot !== null ||
          evidence.resultHash !== checkpointHash(evidence.result) ||
          evidence.source?.selectedHead !== record.prepared.head ||
          evidence.source.tree !== record.prepared.tree
        )
          checkpointError('Only an exactly verified failed checkpoint outcome can be resolved');
        const pod = db
          .prepare(
            'SELECT lifecycle_generation,container_id,worktree_path,last_validation_result,status FROM pods WHERE id=?',
          )
          .get(record.podId) as Record<string, unknown>;
        if (
          !pod ||
          pod.lifecycle_generation !== record.activated.generation ||
          pod.container_id === record.containerId ||
          pod.worktree_path !== record.prepared.worktree ||
          !['failed', 'review_required'].includes(String(pod.status)) ||
          pod.last_validation_result !== JSON.stringify(evidence.result)
        )
          checkpointError(
            'Failed checkpoint outcome changed before resolution',
            'STALE_CHECKPOINT_RECOVERY',
          );
        // Append a failed outcome and explicit human resolution; never erase the
        // original blocked event, reset counters, change status or enqueue work.
        db.prepare(
          "INSERT INTO retained_checkpoint_recovery_events(recovery_id,kind,evidence,created_at) VALUES(?,'checked',?,?)",
        ).run(id, JSON.stringify(evidence), new Date().toISOString());
      })();
    },
    setupCommand(pod: Pod): string | undefined {
      const record = latest(pod.id);
      return record?.activated?.generation === pod.lifecycleGeneration
        ? record.binding.setupCommand
        : undefined;
    },
    list(podId: string) {
      return (
        db
          .prepare(
            'SELECT id FROM retained_checkpoint_recoveries WHERE pod_id=? ORDER BY generation DESC LIMIT 50',
          )
          .all(podId) as { id: string }[]
      ).map((row) => get(row.id) ?? checkpointError('Recovery custody record unavailable'));
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
