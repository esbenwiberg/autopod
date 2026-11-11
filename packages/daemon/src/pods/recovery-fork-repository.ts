import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  EffectiveLaunchConfig,
  EnvironmentQualificationEvidenceV1,
  OperatorActor,
  RecoveryForkContext,
  RecoveryForkRequest,
  RecoveryForkSource,
  ValidationResult,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationDigest } from '../configuration/configuration-digest.js';
import type { RetainedExecutionSelection } from '../configuration/retained-continuation-launch.js';
import { type RecoveryCheckedSource, recoveryCheckHash } from './recovery-fork-checks.js';
import { recoveryForkError } from './recovery-fork-rejection.js';

export { recoveryForkError } from './recovery-fork-rejection.js';

import { retainedPathIdentity } from './retained-path-identity.js';

export const recoveryForkProcessEpoch = randomUUID();
export interface RecoveryForkBinding {
  version: 1;
  parentPodId: string;
  parentHash: string;
  generation: number;
  taskId: string;
  originalLaunch: EffectiveLaunchConfig;
  selection: RetainedExecutionSelection;
  execution: EffectiveLaunchConfig;
  settingsHash: string;
  source: RecoveryForkSource;
  worktreePath: string;
  sourceLocations: string[];
  archiveRoot: string;
  containerId: string;
  resourceKey: string;
  resourceScope: string | null;
  context: RecoveryForkContext;
  contextHash: string;
  accountingHash: string;
}
export interface RecoveryForkFacts {
  prepared: {
    worktree: string;
    bare: string;
    snapshot: string;
    bundle: string;
    bundleHash: string;
    hostInventoryHash: string;
    head: string;
    tree: string;
    files: Array<{ path: string; sha256: string; size: number }>;
    packet: string;
    packetHash: string;
    branch: string;
  };
  admitted: { childPodId: string; digest: string };
  entered: { processEpoch: string };
  candidate: { containerId: string; generation: number; expectedImage: string };
  probing: { processEpoch: string; containerId: string; resourceKey: string };
  qualified: {
    processEpoch: string;
    evidence: EnvironmentQualificationEvidenceV1;
    expiresAt: string;
  };
  worker: { runId: string; generation: number; cycle: number; containerId: string };
  failed: { code: string };
  unknown: { code: string };
}
export interface RecoveryForkRecord {
  id: string;
  parentPodId: string;
  requestId: string;
  actorId: string;
  requestHash: string;
  request: RecoveryForkRequest;
  binding: RecoveryForkBinding;
  processEpoch: string;
  createdAt: string;
  facts: Partial<RecoveryForkFacts>;
}
export function createRecoveryForkRepository(db: Database.Database) {
  function read(where: string, value: string): RecoveryForkRecord | null {
    const row = db
      .prepare(
        `SELECT id,parent_pod_id AS parentPodId,request_id AS requestId,actor_id AS actorId,request_hash AS requestHash,request,binding,process_epoch AS processEpoch,created_at AS createdAt FROM recovery_forks WHERE ${where}=?`,
      )
      .get(value) as
      | (Omit<RecoveryForkRecord, 'binding' | 'request' | 'facts'> & {
          binding: string;
          request: string;
        })
      | undefined;
    if (!row) return null;
    const facts = db
      .prepare('SELECT kind,evidence FROM recovery_fork_facts WHERE operation_id=?')
      .all(row.id) as Array<{ kind: string; evidence: string }>;
    return {
      ...row,
      request: JSON.parse(row.request),
      binding: JSON.parse(row.binding),
      facts: Object.fromEntries(facts.map((f) => [f.kind, JSON.parse(f.evidence)])),
    };
  }
  const get = (id: string) => read('id', id);
  const parent = (id: string) => read('parent_pod_id', id);
  function child(podId: string) {
    const row = db
      .prepare(
        "SELECT operation_id AS id FROM recovery_fork_facts WHERE kind='admitted' AND json_extract(evidence,'$.childPodId')=?",
      )
      .get(podId) as { id: string } | undefined;
    return row ? get(row.id) : null;
  }
  function append<K extends keyof RecoveryForkFacts>(
    id: string,
    kind: K,
    evidence: RecoveryForkFacts[K],
  ) {
    const record = get(id) ?? recoveryForkError('Recovery operation unavailable');
    if (record.facts[kind] || record.facts.failed || record.facts.unknown)
      recoveryForkError('Recovery step already entered or held; observe its saved operation');
    db.prepare('INSERT INTO recovery_fork_facts VALUES(?,?,?,?)').run(
      id,
      kind,
      JSON.stringify(evidence),
      new Date().toISOString(),
    );
  }
  function assertOriginalAvailable(podId: string) {
    if (parent(podId))
      recoveryForkError(
        'Recovery fork retains the original pod, source, context and resources',
        'RECOVERY_FORK_CUSTODY_HELD',
      );
  }
  function evidenceBound(record: RecoveryForkRecord, podId: string) {
    const proof = record.facts.qualified;
    const prepared = record.facts.prepared;
    const candidate = record.facts.candidate;
    if (!proof || !prepared || !candidate) return false;
    const b = proof.evidence.binding;
    const member = db
      .prepare(
        'SELECT e.execution_id AS id,e.task_id AS task,p.runtime,p.model,p.provider_account_id_snapshot AS account FROM retained_task_executions e JOIN pods p ON p.id=e.pod_id WHERE e.pod_id=?',
      )
      .get(podId) as
      | { id: string; task: string; runtime: string; model: string; account: string | null }
      | undefined;
    return (
      proof.evidence.bindingDigest === configurationDigest(b) &&
      b.operationId === record.id &&
      b.requestHash === record.requestHash &&
      b.podId === podId &&
      b.taskId === record.binding.taskId &&
      b.taskId === member?.task &&
      b.executionId === member?.id &&
      member?.runtime === record.binding.execution.ai.main.runtime &&
      member?.model === record.binding.execution.ai.main.model &&
      member?.account ===
        record.binding.execution.agentAccounts[record.binding.execution.ai.main.providerAccountId]
          ?.accountId &&
      b.originalLaunchDigest === record.binding.originalLaunch.digest &&
      b.replacementLaunchDigest === record.binding.execution.digest &&
      b.containerId === candidate.containerId &&
      b.expectedImage.digest === candidate.expectedImage &&
      b.resourceKey === record.facts.probing?.resourceKey &&
      b.source.head === prepared.head &&
      b.source.tree === prepared.tree &&
      b.source.baseCommitSha === record.binding.source.baseCommitSha &&
      b.source.repository === record.binding.source.repository &&
      b.recoveryFork?.parentPodId === record.parentPodId &&
      b.recoveryFork.contextHash === record.binding.contextHash &&
      b.recoveryFork.packetHash === prepared.packetHash &&
      b.recoveryFork.filesHash === configurationDigest(prepared.files)
    );
  }
  function assertWorkerAllowed(podId: string) {
    const record = child(podId);
    if (!record) return null;
    const proof = record.facts.qualified;
    const pod = db
      .prepare(
        'SELECT lifecycle_generation AS generation,container_id AS containerId,launch_config_digest AS digest FROM pods WHERE id=?',
      )
      .get(podId) as { generation: number; containerId: string; digest: string } | undefined;
    if (
      !pod ||
      record.facts.entered?.processEpoch !== recoveryForkProcessEpoch ||
      record.facts.failed ||
      record.facts.unknown ||
      record.facts.worker ||
      !proof ||
      proof.processEpoch !== recoveryForkProcessEpoch ||
      proof.evidence.outcome !== 'qualified' ||
      !evidenceBound(record, podId) ||
      proof.evidence.bindingDigest !== configurationDigest(proof.evidence.binding) ||
      !Number.isFinite(Date.parse(proof.expiresAt)) ||
      Date.parse(proof.expiresAt) <= Date.now() ||
      pod.generation !== proof.evidence.binding.candidateGeneration ||
      pod.containerId !== proof.evidence.binding.containerId ||
      pod.digest !== record.binding.execution.digest
    )
      recoveryForkError(
        'Exact fresh recovery qualification and unused worker admission required',
        'RECOVERY_FORK_QUALIFICATION_REQUIRED',
      );
    return record;
  }
  function checkIdentity(podId: string) {
    const row = db
      .prepare(`SELECT lifecycle_generation AS generation, container_id AS containerId,
      worktree_path AS worktreePath, launch_config_digest AS launchDigest,
      last_validation_result AS result FROM pods WHERE id=?`)
      .get(podId) as
      | (Omit<RecoveryCheckedSource, 'head' | 'tree'> & { result: string | null })
      | undefined;
    if (!row) recoveryForkError('Recovery candidate unavailable');
    return { ...row!, result: row!.result ? (JSON.parse(row!.result) as ValidationResult) : null };
  }
  function checked(podId: string, requireApproval = false) {
    const record = child(podId);
    if (!record) return null;
    const pod = checkIdentity(podId);
    const hash = recoveryCheckHash(pod.result);
    const row = db
      .prepare(
        "SELECT evidence FROM recovery_fork_delivery_evidence WHERE operation_id=? AND kind='checks' AND identity=?",
      )
      .get(record.id, hash) as { evidence: string } | undefined;
    const proof = row ? (JSON.parse(row.evidence) as RecoveryCheckedSource) : null;
    if (
      !proof ||
      !evidenceBound(record, podId) ||
      record.facts.qualified?.evidence.outcome !== 'qualified' ||
      record.facts.failed ||
      record.facts.unknown ||
      proof.generation !== pod.generation ||
      proof.containerId !== pod.containerId ||
      proof.worktreePath !== pod.worktreePath ||
      proof.launchDigest !== pod.launchDigest ||
      pod.result?.overall !== 'pass' ||
      pod.result?.taskReview?.status !== 'pass'
    )
      recoveryForkError(
        'Recovery requires exact qualified child and current source-bound fresh checks',
        'RECOVERY_FORK_DELIVERY_HELD',
      );
    if (requireApproval) {
      const approval = db
        .prepare(
          "SELECT evidence FROM recovery_fork_delivery_evidence WHERE operation_id=? AND kind='approval' AND identity=?",
        )
        .get(record.id, configurationDigest({ proof, hash })) as { evidence: string } | undefined;
      const actor = approval ? JSON.parse(approval.evidence).actor : null;
      if (actor?.type !== 'human' || !actor.userId?.trim())
        recoveryForkError(
          'Recovery requires separate source/check-bound human approval',
          'RECOVERY_FORK_DELIVERY_HELD',
        );
    }
    return proof!;
  }
  return {
    get,
    parent,
    child,
    append,
    checked,
    recordChecks(
      podId: string,
      source: RecoveryCheckedSource,
      result: ValidationResult,
      admissionId: string,
    ) {
      const record = child(podId) ?? recoveryForkError('Recovery child unavailable');
      const current = checkIdentity(podId);
      const admission = db
        .prepare(`SELECT 1 FROM task_retry_attempts WHERE id=? AND pod_id=?
        AND generation=? AND stage='validation' AND started_at IS NOT NULL AND ended_at IS NOT NULL AND outcome='pass'`)
        .get(admissionId, podId, current.generation);
      if (
        !db.inTransaction ||
        !admission ||
        !evidenceBound(record, podId) ||
        !record.facts.worker ||
        result.podId !== podId ||
        result.overall !== 'pass' ||
        result.taskReview?.status !== 'pass' ||
        source.generation !== current.generation ||
        source.containerId !== current.containerId ||
        source.worktreePath !== current.worktreePath ||
        source.launchDigest !== current.launchDigest
      )
        recoveryForkError('Recovery checks do not match qualified execution');
      db.prepare(
        "INSERT INTO recovery_fork_delivery_evidence VALUES(?,'checks',?,?,?) ON CONFLICT DO NOTHING",
      ).run(
        record.id,
        recoveryCheckHash(result),
        JSON.stringify({ ...source, admissionId }),
        new Date().toISOString(),
      );
    },
    approve(podId: string, actor: OperatorActor, source: { head: string; tree: string }) {
      const record = child(podId) ?? recoveryForkError('Recovery child unavailable');
      const proof = checked(podId)!;
      if (
        actor.type !== 'human' ||
        !actor.userId.trim() ||
        source.head !== proof.head ||
        source.tree !== proof.tree
      )
        recoveryForkError('Recovery requires authenticated human approval of exact checked source');
      const hash = recoveryCheckHash(checkIdentity(podId).result);
      db.prepare(
        "INSERT INTO recovery_fork_delivery_evidence VALUES(?,'approval',?,?,?) ON CONFLICT DO NOTHING",
      ).run(
        record.id,
        configurationDigest({ proof, hash }),
        JSON.stringify({ actor, proof, hash }),
        new Date().toISOString(),
      );
    },
    assertPublicationSource(podId: string, source: { commitSha: string; treeSha: string }) {
      const proof = checked(podId, true);
      if (proof && (proof.head !== source.commitSha || proof.tree !== source.treeSha))
        recoveryForkError(
          'Recovery publication differs from human-approved checked source',
          'RECOVERY_FORK_DELIVERY_HELD',
        );
    },
    assertOriginalAvailable,
    assertWorkerAllowed,
    assertUnsharedSource(podId: string, location: string) {
      const source = retainedPathIdentity(location);
      const rows = db
        .prepare(
          'SELECT worktree_path AS location FROM pods WHERE id<>? AND worktree_path IS NOT NULL',
        )
        .all(podId) as { location: string }[];
      if (
        rows.some((row) => {
          const other = retainedPathIdentity(row.location);
          return (
            source === other ||
            source.startsWith(`${other}${path.sep}`) ||
            other.startsWith(`${source}${path.sep}`)
          );
        })
      )
        recoveryForkError(
          'Another pod claims this source location; source ownership requires reconciliation',
        );
    },
    assertTaskExecutionAllowed(podId: string) {
      const rows = db
        .prepare(`SELECT r.id FROM recovery_forks r JOIN retained_task_executions e
        ON e.task_id=json_extract(r.binding,'$.taskId') WHERE e.pod_id=?`)
        .all(podId) as { id: string }[];
      if (rows.some((row) => get(row.id)?.facts.admitted?.childPodId !== podId))
        recoveryForkError(
          'Recovery fork owns this logical task; only its admitted independent child may execute or publish',
          'RECOVERY_FORK_TASK_HELD',
        );
    },
    assertNoDeliveryCustody(taskId: string) {
      if (
        db
          .prepare(`SELECT 1 FROM source_publication_intents WHERE task_id=?
        UNION ALL SELECT 1 FROM delivery_intents WHERE task_id=?
        UNION ALL SELECT 1 FROM canonical_merge_intents WHERE task_id=?
        UNION ALL SELECT 1 FROM external_delivery_observations o JOIN retained_task_executions e ON e.pod_id=o.pod_id WHERE e.task_id=? LIMIT 1`)
          .get(taskId, taskId, taskId, taskId)
      )
        recoveryForkError(
          'Existing publication/delivery/merge custody must be observed through its owning ledger',
        );
    },
    workerSettled(podId: string) {
      const worker = child(podId)?.facts.worker;
      return (
        !!worker &&
        !!db
          .prepare(
            "SELECT 1 FROM retained_task_agent_runs WHERE id=? AND ended_at IS NOT NULL AND failure_category IS NOT 'execution_termination_unverified'",
          )
          .get(worker.runId)
      );
    },
    assertBoundWorker(podId: string) {
      const record = child(podId) ?? recoveryForkError('Recovery child unavailable');
      const worker =
        record.facts.worker ?? recoveryForkError('Recovery worker admission unavailable');
      const proof = record.facts.qualified;
      const current = db
        .prepare(`SELECT r.binding FROM task_agent_runs r JOIN pods p ON p.id=r.pod_id
        JOIN task_retry_attempts a ON a.id=r.id AND a.stage='worker'
        WHERE r.id=? AND r.pod_id=? AND r.generation=p.lifecycle_generation AND r.ended_at IS NULL
        AND r.failure_category IS NOT 'execution_termination_unverified' AND p.container_id=?
        AND a.started_at IS NOT NULL AND a.ended_at IS NULL AND p.status='running'`)
        .get(worker.runId, podId, worker.containerId) as { binding: string } | undefined;
      if (
        !current ||
        !proof ||
        !evidenceBound(record, podId) ||
        proof.evidence.outcome !== 'qualified' ||
        proof.processEpoch !== recoveryForkProcessEpoch ||
        record.facts.failed ||
        record.facts.unknown ||
        !Number.isFinite(Date.parse(proof.expiresAt)) ||
        Date.parse(proof.expiresAt) <= Date.now()
      )
        recoveryForkError('Exact recovery worker/retry ownership unavailable');
      const binding = JSON.parse(current.binding);
      if (
        binding.resource?.containerId !== worker.containerId ||
        binding.resource?.executionTarget !== 'local'
      )
        recoveryForkError('Recovery worker resource changed');
      return record;
    },
    claim(
      id: string,
      parentPodId: string,
      request: RecoveryForkRequest,
      actorId: string,
      binding: RecoveryForkBinding,
    ) {
      if (!db.inTransaction) recoveryForkError('Atomic recovery claim required');
      const requestHash = configurationDigest({ parentPodId, request, actorId });
      const prior = parent(parentPodId);
      if (prior) {
        if (prior.requestHash !== requestHash)
          recoveryForkError(
            'Recovery request or actor conflicts with permanent custody',
            'RECOVERY_FORK_REQUEST_CONFLICT',
          );
        return { record: prior, created: false };
      }
      db.prepare('INSERT INTO recovery_forks VALUES(?,?,?,?,?,?,?,?,?)').run(
        id,
        parentPodId,
        request.id,
        actorId,
        requestHash,
        JSON.stringify(request),
        JSON.stringify(binding),
        recoveryForkProcessEpoch,
        new Date().toISOString(),
      );
      return { record: get(id)!, created: true };
    },
    bindWorker(
      podId: string,
      runId: string,
      generation: number,
      cycle: number,
      containerId: string | null,
    ) {
      const record = assertWorkerAllowed(podId);
      if (record) {
        if (!db.inTransaction || !containerId)
          recoveryForkError('Atomic exact recovery worker binding required');
        append(record.id, 'worker', { runId, generation, cycle, containerId: containerId! });
      }
    },
  };
}
export type RecoveryForkRepository = ReturnType<typeof createRecoveryForkRepository>;

export function assertRecoveryForkResourceAvailable(
  db: Database.Database,
  containerId: string,
): void {
  if (
    db
      .prepare("SELECT 1 FROM recovery_forks WHERE json_extract(binding,'$.containerId')=?")
      .get(containerId)
  )
    recoveryForkError('Recovery fork retains this original resource', 'RECOVERY_FORK_CUSTODY_HELD');
}
export function assertRecoveryForkPathAvailable(db: Database.Database, location: string): void {
  const rows = db
    .prepare(`SELECT json_extract(binding,'$.worktreePath') AS location FROM recovery_forks
    UNION ALL SELECT value AS location FROM recovery_forks,json_each(binding,'$.sourceLocations')
    UNION ALL SELECT json_extract(binding,'$.archiveRoot') || '/' || id || '/host' AS location FROM recovery_forks WHERE json_extract(binding,'$.archiveRoot') IS NOT NULL
    UNION ALL SELECT json_extract(binding,'$.archiveRoot') || '/' || id || '/source.bundle' AS location FROM recovery_forks WHERE json_extract(binding,'$.archiveRoot') IS NOT NULL
    UNION ALL SELECT json_extract(binding,'$.archiveRoot') || '/' || id || '/handoff.json' AS location FROM recovery_forks WHERE json_extract(binding,'$.archiveRoot') IS NOT NULL
    UNION ALL SELECT json_extract(evidence,'$.snapshot') AS location FROM recovery_fork_facts WHERE kind='prepared'
    UNION ALL SELECT json_extract(evidence,'$.bundle') AS location FROM recovery_fork_facts WHERE kind='prepared'
    UNION ALL SELECT json_extract(evidence,'$.packet') AS location FROM recovery_fork_facts WHERE kind='prepared'`)
    .all() as Array<{ location: string }>;
  const overlap = (a: string, b: string) =>
    a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
  for (const row of rows)
    for (const held of [path.resolve(row.location), retainedPathIdentity(row.location)])
      for (const candidate of [path.resolve(location), retainedPathIdentity(location)])
        if (overlap(held, candidate))
          recoveryForkError(
            'Recovery fork retains this original/private source path',
            'RECOVERY_FORK_CUSTODY_HELD',
          );
}
