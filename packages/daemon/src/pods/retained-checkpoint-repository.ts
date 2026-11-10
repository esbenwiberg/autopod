import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  AutopodError,
  type CheckpointRecoveryRequest,
  type OperatorActor,
  type Pod,
  type ReportBlockerPayload,
  type RewriteRepairRetryTarget,
  type TaskRetryAuthorization,
  type ValidationResult,
} from '@autopod/shared';
import { createRetainedCodingRepository } from './retained-coding-repository.js';
import {
  assertFinalizationResourceAvailable,
  createRetainedFinalizationRepository,
  ownsRetainedFinalization,
} from './retained-finalization-repository.js';
import {
  type RetainedPrevalidationSource,
  retainedPrevalidationSource,
} from './retained-prevalidation-source.js';
import { assertStalledRecoveryResourceAvailable } from './stalled-worker-recovery-repository.js';

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
  const identities = new Set<string>(
    (db.prepare('SELECT pod_id FROM retained_finalizations').all() as { pod_id: string }[]).map(
      (row) => row.pod_id,
    ),
  );
  for (const row of db.prepare('SELECT parent_pod_id AS podId FROM recovery_forks').all() as {
    podId: string;
  }[])
    identities.add(row.podId);
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
    taskHash: string;
    artifactsPath: string | null;
  };
  /** New explicit selection, not legacy unknown-execution reconciliation. */
  continuation?: {
    remoteHead?: string;
    prepareOnly: boolean;
    /** Additive checks-only gate; never rewrites or removes frozen workflow phases. */
    reviewPolicy?: 'independent-v1';
    execution?: RetainedExecutionSelection;
    infrastructure?: {
      version: 1;
      mode: 'checks' | 'rework';
      qualification: string;
      instructions?: { content: string; sha256: string };
      originalTree: string;
      /** Exact completed failed repair whose sealed source is selected again. */
      predecessorRepairId?: string;
      /** Exact completed checks-only failure; no original worker outcome is inferred. */
      predecessorChecksId?: string;
    };
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
  originalEvidence: {
    result: ValidationResult | null;
    preSubmitReview: Pod['preSubmitReview'];
    infrastructureReports?: { id: string; timestamp: string; payload: ReportBlockerPayload }[];
    prevalidationSource?: RetainedPrevalidationSource;
  };
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
  infrastructure?: {
    stopDispatched: boolean;
    stopped: boolean;
    worker: { runId: string; generation: number; containerId: string; cycle: number } | null;
    candidate: {
      head: string;
      tree: string;
      runId: string;
      generation: number;
      cycle: number;
      containerId: string;
    } | null;
  };
}
/** Exact prospective candidate authorization; actual Git proof is required at selection. */
export function rewriteRepairRetryBinding(
  record: CheckpointRecoveryRecord,
  source: RewriteRepairRetryTarget,
): NonNullable<TaskRetryAuthorization['rewriteRepair']> {
  const owner = record.binding.approvalRewrite ?? checkpointError('Rewrite-owned repair required');
  return {
    recoveryId: record.id,
    candidateHead: source.candidateHead,
    candidateTree: source.candidateTree,
    generation: record.generation + 1,
    requestHash: record.requestHash,
    configurationHash: record.binding.configurationHash,
    rewriteId: owner.id,
    failedDispatchId: owner.dispatchId,
  };
}
const stopScopes = new WeakMap<
  Database.Database,
  AsyncLocalStorage<{ id: string; assertCurrent(): void }>
>();
export function ownsInfrastructureRecoveryStop(
  db: Database.Database,
  containerId: string,
): boolean {
  const owner = stopScopes.get(db)?.getStore();
  if (!owner) return false;
  owner.assertCurrent();
  const record = createRetainedCheckpointRepository(db).get(owner.id);
  return Boolean(
    record?.binding.continuation?.infrastructure &&
      record.containerId === containerId &&
      record.infrastructure?.stopDispatched &&
      !record.infrastructure.stopped &&
      !record.activated &&
      !record.blocked,
  );
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
  allowCodingMutation = false,
): void {
  assertStalledRecoveryResourceAvailable(db, containerId);
  assertFinalizationResourceAvailable(db, containerId);
  if (createRetainedCodingRepository(db).retains(containerId)) {
    if (!allowCodingMutation)
      checkpointError(
        'Coding candidate retains source/report custody; no release is authorized',
        'REPAIR_CANDIDATE_RETAINED',
      );
    createRetainedCodingRepository(db).assertMutationAllowed(containerId);
  }
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
  /** Diagnostic projection only: neither settlement nor selection/admission evidence.
   * Bound fields inside SQLite before crossing into JS; never load whole payloads.
   * Keep this independent of originalEvidence and its immutable hash meaning.
   */
  function infrastructureNeeds(pod: Pick<Pod, 'id' | 'lifecycleGeneration'>) {
    const rows = db
      .prepare(`WITH reports AS (
      SELECT id,created_at,CASE WHEN json_valid(payload) THEN payload END AS data
      FROM escalations WHERE pod_id=? AND type='report_blocker'
    ) SELECT substr(id,1,257) AS id,
      CASE WHEN json_type(data,'$.owner')='text'
        THEN substr(json_extract(data,'$.owner'),1,257) END AS owner,
      CASE WHEN json_type(data,'$.phase')='text'
        THEN substr(json_extract(data,'$.phase'),1,257) END AS phase,
      CASE WHEN json_type(data,'$.needs')='text'
        THEN substr(json_extract(data,'$.needs'),1,1025) END AS needs
      FROM reports WHERE json_extract(data,'$.kind')='infrastructure'
      AND json_extract(data,'$.lifecycleGeneration')=?
      ORDER BY created_at,reports.id LIMIT 21`)
      .all(pod.id, pod.lifecycleGeneration) as {
      id: string;
      owner: string | null;
      phase: string | null;
      needs: string | null;
    }[];
    return {
      truncated: rows.length > 20,
      needs: rows.slice(0, 20).map((row) => ({
        id: row.id.slice(0, 256),
        owner: row.owner?.slice(0, 256),
        phase: row.phase?.slice(0, 256),
        needs: row.needs?.slice(0, 1024),
        truncated:
          row.id.length > 256 ||
          (row.owner?.length ?? 0) > 256 ||
          (row.phase?.length ?? 0) > 256 ||
          (row.needs?.length ?? 0) > 1024,
      })),
    };
  }
  function originalEvidence(pod: Pod): CheckpointRecoveryRecord['originalEvidence'] | null {
    if (pod.lastValidationResult)
      return { result: pod.lastValidationResult, preSubmitReview: pod.preSubmitReview };
    const finalization = pod.finalization;
    if (
      pod.status !== 'failed' ||
      finalization?.generation !== pod.lifecycleGeneration ||
      finalization.phase !== 'ready' ||
      !finalization.agentSettledAt ||
      !finalization.sourcePreservedAt
    )
      return null;
    const rows = db
      .prepare(`SELECT id,created_at AS timestamp,substr(payload,1,65537) AS payload FROM escalations
      WHERE pod_id=? AND type='report_blocker'
      AND json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.kind')='infrastructure'
      AND json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.lifecycleGeneration')=?
      ORDER BY created_at,id LIMIT 101`)
      .all(pod.id, pod.lifecycleGeneration) as {
      id: string;
      timestamp: string;
      payload: string;
    }[];
    if (!rows.length) {
      const source = retainedPrevalidationSource(db, pod);
      return source
        ? { result: null, preSubmitReview: pod.preSubmitReview, prevalidationSource: source }
        : null;
    }
    if (
      rows.length > 100 ||
      rows.some((row) => Buffer.byteLength(row.payload) > 65536) ||
      rows.reduce((size, row) => size + Buffer.byteLength(row.payload), 0) > 1048576
    )
      checkpointError('Infrastructure report evidence exceeds its safe bound');
    const infrastructureReports = rows.map((row) => {
      const payload = JSON.parse(row.payload) as ReportBlockerPayload;
      if (
        payload.kind !== 'infrastructure' ||
        payload.lifecycleGeneration !== pod.lifecycleGeneration ||
        payload.requiresResponse !== false ||
        !['autopod', 'parent', 'validation'].includes(payload.owner ?? '') ||
        typeof payload.phase !== 'string' ||
        !payload.phase.trim() ||
        typeof payload.description !== 'string' ||
        !payload.description.trim() ||
        typeof payload.needs !== 'string' ||
        !payload.needs.trim() ||
        !Array.isArray(payload.attempted) ||
        payload.attempted.some((item) => typeof item !== 'string')
      )
        checkpointError('Infrastructure report evidence is incomplete');
      return { id: row.id, timestamp: row.timestamp, payload };
    });
    return { result: null, preSubmitReview: pod.preSubmitReview, infrastructureReports };
  }
  const evidenceHash = (evidence: CheckpointRecoveryRecord['originalEvidence']) =>
    checkpointHash(
      evidence.result ??
        (evidence.prevalidationSource
          ? { result: null, prevalidationSource: evidence.prevalidationSource }
          : { result: null, infrastructureReports: evidence.infrastructureReports }),
    );
  function selectionEvidence(pod: Pod) {
    const evidence = originalEvidence(pod);
    return evidence
      ? {
          expectedGeneration: pod.lifecycleGeneration,
          expectedResultHash: evidenceHash(evidence),
          ...(evidence.infrastructureReports
            ? { infrastructureReports: evidence.infrastructureReports }
            : {}),
        }
      : null;
  }
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
      ...(JSON.parse(raw.binding).continuation?.infrastructure
        ? {
            infrastructure: (() => {
              const rows = db
                .prepare(
                  'SELECT kind,evidence FROM retained_infrastructure_events WHERE recovery_id=?',
                )
                .all(id) as { kind: string; evidence: string }[];
              const read = <T>(kind: string): T | null => {
                const row = rows.find((entry) => entry.kind === kind);
                return row ? (JSON.parse(row.evidence) as T) : null;
              };
              return {
                stopDispatched: rows.some((row) => row.kind === 'stop-dispatched'),
                stopped: rows.some((row) => row.kind === 'stopped'),
                worker:
                  read<NonNullable<CheckpointRecoveryRecord['infrastructure']>['worker']>('worker'),
                candidate:
                  read<NonNullable<CheckpointRecoveryRecord['infrastructure']>['candidate']>(
                    'candidate',
                  ),
              };
            })(),
          }
        : {}),
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
    if (ownsRetainedFinalization(db, podId)) return;
    createRetainedFinalizationRepository(db).assertAvailable(podId);
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
  function infrastructureEvent(
    id: string,
    kind: 'stop-dispatched' | 'stopped' | 'worker' | 'candidate',
    evidence: unknown,
  ) {
    const record = get(id) ?? checkpointError('Recovery unavailable');
    if (
      !record.binding.continuation?.infrastructure ||
      scope(db).getStore() !== id ||
      record.blocked ||
      record.checked
    )
      checkpointError('Owned infrastructure recovery required');
    assertAvailable(record.podId);
    db.prepare('INSERT INTO retained_infrastructure_events VALUES(?,?,?,?)').run(
      id,
      kind,
      JSON.stringify(evidence),
      new Date().toISOString(),
    );
  }
  return {
    get,
    latest,
    infrastructureEvent,
    async stopOriginal(id: string, stop: () => Promise<void>, assertCurrent: () => void) {
      const record = get(id) ?? checkpointError('Recovery unavailable');
      if (
        !record.binding.continuation?.infrastructure ||
        !record.prepared ||
        record.activated ||
        record.checked ||
        record.blocked ||
        scope(db).getStore() !== id
      )
        checkpointError('Only owned prepared original quiescence may dispatch a stop');
      if (record.infrastructure?.stopDispatched) return;
      assertCurrent();
      infrastructureEvent(id, 'stop-dispatched', {
        containerId: record.containerId,
        resourceKey: record.resourceKey,
      });
      let storage = stopScopes.get(db);
      if (!storage) {
        storage = new AsyncLocalStorage();
        stopScopes.set(db, storage);
      }
      await storage.run({ id, assertCurrent }, stop);
    },
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
    requiredReview(pod: Pod): boolean {
      const record = latest(pod.id);
      if (!record?.binding.continuation?.reviewPolicy) return false;
      if (
        record.checked &&
        record.activated &&
        pod.lifecycleGeneration > record.activated.generation
      )
        return false;
      assertAvailable(pod.id);
      const task = db
        .prepare('SELECT task_id AS id FROM task_executions WHERE pod_id=?')
        .get(pod.id) as { id: string } | undefined;
      if (
        record.binding.continuation.reviewPolicy !== 'independent-v1' ||
        task?.id !== record.taskId ||
        scope(db).getStore() !== record.id ||
        !record.checking ||
        record.checked ||
        record.blocked ||
        record.generation + 1 !== pod.lifecycleGeneration ||
        record.activated?.generation !== pod.lifecycleGeneration ||
        record.checking.generation !== pod.lifecycleGeneration ||
        record.prepared?.worktree !== pod.worktreePath ||
        pod.status !== 'validating' ||
        !pod.containerId ||
        pod.containerId === record.containerId
      )
        checkpointError(
          'Mandatory continuation review no longer matches its owned source/generation',
        );
      return true;
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
          'UPDATE pods SET launch_config_digest=? WHERE id=? AND launch_config_digest=? AND lifecycle_generation=? AND container_id IS NULL AND worktree_path=? AND skip_agent=? AND execution_target=?',
        )
        .run(
          execution.digest,
          record.podId,
          execution.parentDigest,
          record.generation + 1,
          record.prepared.worktree,
          createRetainedCodingRepository(db).get(id) ||
            record.binding.continuation?.infrastructure?.mode === 'rework'
            ? 0
            : 1,
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
    selectionEvidence,
    completedChecksAdmission(pod: Pod): boolean {
      const row = db
        .prepare(`SELECT pod_id AS podId,generation,started_at AS startedAt,ended_at AS endedAt,outcome
        FROM task_retry_attempts WHERE task_id=(SELECT task_id FROM task_executions WHERE pod_id=?)
        AND stage='validation' ORDER BY rowid DESC LIMIT 1`)
        .get(pod.id) as
        | {
            podId: string;
            generation: number;
            startedAt: string | null;
            endedAt: string | null;
            outcome: string | null;
          }
        | undefined;
      return Boolean(
        row &&
          row.podId === pod.id &&
          row.generation === pod.lifecycleGeneration &&
          row.startedAt &&
          row.endedAt &&
          ['nonretryable', 'transient'].includes(row.outcome ?? ''),
      );
    },
    prevalidationSource: (pod: Pod) => originalEvidence(pod)?.prevalidationSource ?? null,
    infrastructureNeeds,
    hasTypedPrerequisiteBlocker(pod: Pick<Pod, 'id' | 'lifecycleGeneration'>): boolean {
      return Boolean(
        db
          .prepare(`SELECT 1 FROM escalations WHERE pod_id=? AND type='report_blocker'
          AND json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.kind')='infrastructure'
          AND json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.lifecycleGeneration')=?
          AND json_type(CASE WHEN json_valid(payload) THEN payload END,'$.prerequisiteBlocker') IS NOT NULL
          LIMIT 1`)
          .get(pod.id, pod.lifecycleGeneration),
      );
    },
    claim(input: {
      pod: Pod;
      taskId: string;
      resourceKey: string;
      request: CheckpointRecoveryRequest;
      actor: OperatorActor;
      binding: CheckpointRecoveryBinding;
      assertCurrent(): void;
      onClaim?(): void;
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
        const evidence = originalEvidence(pod);
        if (!evidence || (!evidence.result && !input.binding.continuation))
          checkpointError(
            'Original source/resource/result or preserved infrastructure evidence required',
          );
        if (
          request.expectedGeneration !== pod.lifecycleGeneration ||
          request.expectedResultHash !== evidenceHash(evidence) ||
          input.binding.head !== request.checkpointHead ||
          input.binding.resultHash !== request.expectedResultHash
        )
          checkpointError(
            'Expected generation, result and checkpoint must match',
            'STALE_CHECKPOINT_RECOVERY',
          );
        if (!pod.containerId || !pod.worktreePath)
          checkpointError('Original source/resource required');
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
          current.last_validation_result !==
            (pod.lastValidationResult ? JSON.stringify(pod.lastValidationResult) : null)
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
          JSON.stringify(evidence),
          new Date().toISOString(),
        );
        input.onClaim?.();
        return {
          record: get(request.id) ?? checkpointError('Recovery claim was not retained'),
          acquired: true,
        };
      })();
    },
    repairDecision(pod: Pod): CheckpointRecoveryRecord | null {
      const record = latest(pod.id);
      const worker = record?.infrastructure?.worker;
      if (
        record?.binding.continuation?.infrastructure?.mode !== 'rework' ||
        !worker ||
        record.checked ||
        record.blocked ||
        record.infrastructure?.candidate ||
        !record.checking ||
        record.activated?.generation !== pod.lifecycleGeneration ||
        worker.generation !== pod.lifecycleGeneration ||
        record.checking.generation !== pod.lifecycleGeneration ||
        worker.containerId !== pod.containerId ||
        record.prepared?.worktree !== pod.worktreePath ||
        pod.status !== 'awaiting_input' ||
        pod.pauseReason ||
        pod.pendingEscalation?.type !== 'ask_human'
      )
        return null;
      const run = db
        .prepare('SELECT ended_at FROM task_agent_runs WHERE id=? AND pod_id=? AND generation=?')
        .get(worker.runId, pod.id, pod.lifecycleGeneration) as
        | { ended_at: string | null }
        | undefined;
      return run && !run.ended_at ? record : null;
    },
    ownsRepairExecution(podId: string): boolean {
      const record = latest(podId);
      if (
        record?.binding.continuation?.infrastructure?.mode !== 'rework' ||
        scope(db).getStore() !== record.id ||
        !record.checking ||
        record.checked ||
        record.blocked
      )
        return false;
      assertAvailable(podId);
      const pod = db
        .prepare(
          'SELECT lifecycle_generation AS generation,container_id AS containerId,worktree_path AS worktreePath FROM pods WHERE id=?',
        )
        .get(podId) as
        | { generation: number; containerId: string | null; worktreePath: string }
        | undefined;
      return Boolean(
        pod &&
          pod.generation === record.activated?.generation &&
          pod.generation === record.checking.generation &&
          pod.worktreePath === record.prepared?.worktree &&
          pod.containerId &&
          pod.containerId !== record.containerId,
      );
    },
    freezeRepairCandidate(id: string, source: { head: string; tree: string }) {
      const record = get(id) ?? checkpointError('Recovery unavailable');
      const worker = record.infrastructure?.worker;
      if (
        !worker ||
        record.binding.continuation?.infrastructure?.mode !== 'rework' ||
        record.infrastructure?.candidate
      )
        checkpointError('Exactly one completed repair source is required');
      const run = db
        .prepare(
          'SELECT generation,cycle,binding,ended_at,outcome FROM task_agent_runs WHERE id=? AND pod_id=?',
        )
        .get(worker.runId, record.podId) as
        | {
            generation: number;
            cycle: number;
            binding: string;
            ended_at: string | null;
            outcome: string;
          }
        | undefined;
      if (
        !run?.ended_at ||
        run.outcome !== 'completed' ||
        run.generation !== worker.generation ||
        run.cycle !== worker.cycle ||
        JSON.parse(run.binding).resource?.containerId !== worker.containerId
      )
        checkpointError('Repair worker termination/source ownership remains unverified');
      infrastructureEvent(id, 'candidate', { ...source, ...worker });
    },
    recordRepairWorker(
      podId: string,
      runId: string,
      generation: number,
      cycle: number,
      containerId: string | null,
    ) {
      const record = latest(podId);
      if (record?.binding.continuation?.infrastructure?.mode !== 'rework') return;
      if (!containerId || !db.inTransaction)
        checkpointError('Atomic resource-bound repair worker required');
      infrastructureEvent(record.id, 'worker', { runId, generation, cycle, containerId });
    },
    assertWorkerAllowed(podId: string): boolean {
      const current = latest(podId);
      if (current && createRetainedCodingRepository(db).get(current.id)) {
        assertAvailable(podId);
        createRetainedCodingRepository(db).assertWorkerAllowed(podId);
        return true;
      }
      if (current?.binding.continuation?.infrastructure?.mode === 'rework' && !current.checked) {
        assertAvailable(podId);
        const pod = db
          .prepare(
            'SELECT lifecycle_generation AS generation,worktree_path AS worktreePath,container_id AS containerId,status FROM pods WHERE id=?',
          )
          .get(podId) as
          | { generation: number; worktreePath: string; containerId: string; status: string }
          | undefined;
        if (
          scope(db).getStore() !== current.id ||
          !current.infrastructure?.stopped ||
          current.infrastructure.worker ||
          current.blocked ||
          !current.checking ||
          !pod ||
          pod.generation !== current.activated?.generation ||
          pod.generation !== current.checking.generation ||
          pod.worktreePath !== current.prepared?.worktree ||
          !pod.containerId ||
          pod.containerId === current.containerId ||
          pod.status !== 'running'
        )
          checkpointError('Only one owned repair worker on the selected replacement is authorized');
        return true;
      }
      if (current && !current.checked)
        checkpointError(
          'Checkpoint recovery admits fresh checks only, never a coding worker',
          'CHECKPOINT_CHECKS_ONLY',
        );
      return false;
    },
  };
}
export type RetainedCheckpointRepository = ReturnType<typeof createRetainedCheckpointRepository>;
