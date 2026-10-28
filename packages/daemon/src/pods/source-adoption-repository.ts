import type { OperatorActor, Pod, ValidationResult } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { sourceAdoptionError, sourceHash } from './source-adoption-identity.js';
import type { SourceAdoptionStage, SourceAdoptionState } from './source-adoption-types.js';
import { type SourceCommandJournal, createSourceCommandJournal } from './source-command-journal.js';
export { sourceAdoptionError, sourceHash } from './source-adoption-identity.js';
export function sourcePodFingerprint(pod: Pod): string {
  return sourceHash([
    pod.containerId,
    pod.executionTarget,
    pod.worktreePath,
    pod.branch,
    pod.baseBranch,
    pod.runtime,
    pod.model,
    pod.providerIdSnapshot,
    pod.providerAccountIdSnapshot,
    pod.profileSnapshot,
    pod.contract,
    pod.options,
    pod.task,
    pod.startCommitSha,
    pod.launchConfigDigest,
    pod.skipValidation,
    pod.skipValidationActor,
    pod.pendingEscalation,
  ]);
}
export interface SourceAdoptionBinding {
  generation: number;
  fingerprint: string;
  repository: string;
  branch: string;
  baseBranch: string;
  containerId: string;
  /** Immutable original provider/endpoint/region/group/resource namespace; never a label. */
  resourceKey: string;
  worktreePath: string;
  oldHead: string;
  targetHead: string;
  /** Human-admitted, source-bound dependency preparation; executed by normal validation admission. */
  dependencySetupCommand?: string;
}
export interface SourcePreservation {
  host: string;
  container: string;
  bundle: string;
  bundleHash: string;
  tree: string;
}
export interface SourceAdoptionRecord {
  id: string;
  podId: string;
  taskId: string;
  binding: SourceAdoptionBinding;
  actor: OperatorActor;
  reason: string;
  stage: SourceAdoptionStage;
  preservation: SourcePreservation | null;
  adoptedGeneration: number | null;
  validationHash: string | null;
  validation: 'pass' | 'fail' | null;
  error: string | null;
}
export function sourceAdoptionState(row: SourceAdoptionRecord): SourceAdoptionState {
  return {
    id: row.id,
    podId: row.podId,
    generation: row.adoptedGeneration ?? row.binding.generation,
    oldHeadSha: row.binding.oldHead,
    targetHeadSha: row.binding.targetHead,
    stage: row.stage,
    validation: row.validation ?? 'pending',
    error: row.error,
    actor: row.actor,
    reports: 'not-released',
    delivery: 'not-authorized',
  };
}
export interface SourceAdoptionRepository {
  readonly commands: SourceCommandJournal;
  get(id: string): SourceAdoptionRecord | null;
  list(podId: string): SourceAdoptionRecord[];
  assertAvailable(podId: string, owner?: string): void;
  hasCustody(podId: string): boolean;
  claim(
    id: string,
    podId: string,
    binding: SourceAdoptionBinding,
    actor: OperatorActor,
    reason: string,
    assertCurrent: () => void,
  ): SourceAdoptionRecord;
  advance(
    id: string,
    expected: SourceAdoptionStage,
    next: SourceAdoptionStage,
    details?: {
      preservation?: SourcePreservation;
      generation?: number;
      validationHash?: string;
      validation?: 'pass' | 'fail';
    },
  ): void;
  fail(id: string, code: string): void;
  observeChecksResult(id: string, result: ValidationResult): void;
  claimChecksInvocation(id: string, assertCurrent: () => void): void;
  retains(containerId: string): boolean;
  retainedContainerIds(): string[];
  assertDeletable(podId: string): void;
  assertReleasable(containerId: string): void;
  assertDeliveryAllowed(podId: string): void;
}
export function createSourceAdoptionRepository(db: Database.Database): SourceAdoptionRepository {
  const commands = createSourceCommandJournal(db);
  const get = (id: string): SourceAdoptionRecord | null => {
    const row = db.prepare('SELECT * FROM source_adoptions WHERE id=?').get(id) as
      | {
          id: string;
          pod_id: string;
          task_id: string;
          binding: string;
          actor: string;
          reason: string;
          stage: SourceAdoptionStage;
          preservation: string | null;
          adopted_generation: number | null;
          validation_hash: string | null;
          validation_result: 'pass' | 'fail' | null;
          error: string | null;
        }
      | undefined;
    return row
      ? {
          id: row.id,
          podId: row.pod_id,
          taskId: row.task_id,
          binding: JSON.parse(row.binding),
          actor: JSON.parse(row.actor),
          reason: row.reason,
          stage: row.stage,
          preservation: row.preservation ? JSON.parse(row.preservation) : null,
          adoptedGeneration: row.adopted_generation,
          validationHash: row.validation_hash,
          validation: row.validation_result,
          error: row.error,
        }
      : null;
  };
  const task = (podId: string) => {
    const row = db.prepare('SELECT task_id FROM task_executions WHERE pod_id=?').get(podId) as
      | { task_id: string }
      | undefined;
    return row?.task_id ?? sourceAdoptionError('Task identity unavailable');
  };
  const event = (id: string, value: unknown) =>
    db
      .prepare('INSERT INTO source_adoption_events(adoption_id,event,created_at) VALUES(?,?,?)')
      .run(id, JSON.stringify(value), new Date().toISOString());
  const assertAvailable = (podId: string, owner?: string) => {
    const blocked = db
      .prepare(`SELECT id FROM source_adoptions WHERE completed_at IS NULL AND
      (task_id=(SELECT task_id FROM task_executions WHERE pod_id=?) OR pod_id=?
      OR json_extract(binding,'$.containerId')=(SELECT container_id FROM pods WHERE id=?)
      OR json_extract(binding,'$.worktreePath')=(SELECT worktree_path FROM pods WHERE id=?))`)
      .all(podId, podId, podId, podId) as { id: string }[];
    if (blocked.some((row) => row.id !== owner))
      sourceAdoptionError(
        'Source adoption owns this task/resource. Observe its durable operation; do not retry another worker, validation or delivery.',
        'SOURCE_ADOPTION_IN_PROGRESS',
      );
  };
  return {
    commands,
    get,
    list(podId: string) {
      return (
        db
          .prepare('SELECT id FROM source_adoptions WHERE task_id=? ORDER BY created_at,id')
          .all(task(podId)) as { id: string }[]
      )
        .map(({ id }) => get(id))
        .filter((row): row is SourceAdoptionRecord => row !== null);
    },
    assertAvailable,
    hasCustody(podId: string) {
      return Boolean(
        db
          .prepare(`SELECT 1 FROM source_adoptions WHERE pod_id=? OR
        task_id=(SELECT task_id FROM task_executions WHERE pod_id=?) OR
        json_extract(binding,'$.containerId')=(SELECT container_id FROM pods WHERE id=?) OR
        json_extract(binding,'$.worktreePath')=(SELECT worktree_path FROM pods WHERE id=?) LIMIT 1`)
          .get(podId, podId, podId, podId),
      );
    },
    claim: db.transaction(
      (
        id: string,
        podId: string,
        binding: SourceAdoptionBinding,
        actor: OperatorActor,
        reason: string,
        assertCurrent: () => void,
      ) => {
        if (
          actor.type !== 'human' ||
          !actor.userId ||
          reason.trim().length < 10 ||
          reason.length > 4000
        )
          sourceAdoptionError('An explicit human actor and meaningful reason are required');
        if (
          !id ||
          !binding.containerId ||
          !binding.resourceKey ||
          !binding.worktreePath ||
          !Number.isSafeInteger(binding.generation) ||
          binding.generation < 1 ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(binding.oldHead) ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(binding.targetHead) ||
          binding.oldHead === binding.targetHead
        )
          sourceAdoptionError('Exact original/target source and resource binding are required');
        const old = get(id);
        if (old) {
          if (
            old.podId !== podId ||
            sourceHash(old.binding) !== sourceHash(binding) ||
            sourceHash(old.actor) !== sourceHash(actor) ||
            old.reason !== reason
          )
            sourceAdoptionError(
              'Request ID already belongs to another adoption',
              'SOURCE_ADOPTION_CONFLICT',
            );
          return old;
        }
        assertCurrent();
        assertAvailable(podId);
        db.prepare(`INSERT INTO source_adoptions(id,pod_id,task_id,binding,actor,reason,stage,created_at)
        VALUES(?,?,?,?,?,?,'claimed',?)`).run(
          id,
          podId,
          task(podId),
          JSON.stringify(binding),
          JSON.stringify(actor),
          reason,
          new Date().toISOString(),
        );
        event(id, { stage: 'claimed' });
        return get(id) ?? sourceAdoptionError('Adoption claim unavailable');
      },
    ),
    advance: db.transaction(
      (
        id: string,
        expected: SourceAdoptionStage,
        next: SourceAdoptionStage,
        details: {
          preservation?: SourcePreservation;
          generation?: number;
          validationHash?: string;
          validation?: 'pass' | 'fail';
        } = {},
      ) => {
        const current = get(id);
        if (!current || current.stage !== expected) sourceAdoptionError('Adoption phase changed');
        if (next === 'checked') commands.assertSettled(id);
        db.prepare(`UPDATE source_adoptions SET stage=?,preservation=COALESCE(?,preservation),
        adopted_generation=COALESCE(?,adopted_generation),validation_hash=COALESCE(?,validation_hash),
        validation_result=COALESCE(?,validation_result),error=NULL,completed_at=? WHERE id=?`).run(
          next,
          details.preservation ? JSON.stringify(details.preservation) : null,
          details.generation ?? null,
          details.validationHash ?? null,
          details.validation ?? null,
          next === 'checked' ? new Date().toISOString() : null,
          id,
        );
        event(id, { stage: next, ...details });
      },
    ),
    fail: db.transaction((id: string, code: string) => {
      const result = db
        .prepare('UPDATE source_adoptions SET error=? WHERE id=? AND completed_at IS NULL')
        .run(code.slice(0, 500), id);
      if (result.changes !== 1) sourceAdoptionError('No unsettled source adoption exists');
      event(id, { error: code.slice(0, 500) });
    }),
    claimChecksInvocation: db.transaction((id: string, assertCurrent: () => void) => {
      const row = get(id);
      if (!row || row.stage !== 'checking' || row.error || !row.adoptedGeneration)
        sourceAdoptionError('No active source checks admission exists');
      assertCurrent();
      if (db.prepare('SELECT 1 FROM source_check_invocations WHERE adoption_id=?').get(id))
        sourceAdoptionError(
          'This source checks invocation is already claimed. Observe/reconcile it; do not replay.',
          'SOURCE_CHECKS_ALREADY_CLAIMED',
        );
      db.prepare(
        'INSERT INTO source_check_invocations(adoption_id,pod_id,generation,claimed_at) VALUES(?,?,?,?)',
      ).run(id, row.podId, row.adoptedGeneration, new Date().toISOString());
      event(id, { observation: 'checks-invocation-claimed', generation: row.adoptedGeneration });
    }),
    observeChecksResult(id: string, result: ValidationResult) {
      if (!get(id)) sourceAdoptionError('Source checks observation has no original admission');
      event(id, { observation: 'unaccepted-validation-result', result });
    },
    retains(containerId: string) {
      return Boolean(
        db
          .prepare("SELECT 1 FROM source_adoptions WHERE json_extract(binding,'$.containerId')=?")
          .get(containerId),
      );
    },
    retainedContainerIds() {
      return (
        db
          .prepare(
            "SELECT DISTINCT json_extract(binding,'$.containerId') AS id FROM source_adoptions",
          )
          .all() as { id: string }[]
      ).map((row) => row.id);
    },
    assertDeletable(podId: string) {
      if (db.prepare('SELECT 1 FROM source_adoptions WHERE task_id=?').get(task(podId)))
        sourceAdoptionError(
          'Source adoption custody retains original source/reports; cleanup has not been authorized.',
          'SOURCE_CUSTODY_HELD',
        );
    },
    assertReleasable(containerId: string) {
      if (
        db
          .prepare("SELECT 1 FROM source_adoptions WHERE json_extract(binding,'$.containerId')=?")
          .get(containerId)
      )
        sourceAdoptionError(
          'Original source/report resource is held by source adoption.',
          'SOURCE_CUSTODY_HELD',
        );
    },
    assertDeliveryAllowed(podId: string) {
      if (db.prepare('SELECT 1 FROM source_adoptions WHERE task_id=?').get(task(podId)))
        sourceAdoptionError(
          'Source adoption authorizes checks only. Publishing/merging requires a separately reviewed delivery decision; keep the original PR target and no-merge constraint.',
          'SOURCE_ADOPTION_DELIVERY_HELD',
        );
    },
  };
}
