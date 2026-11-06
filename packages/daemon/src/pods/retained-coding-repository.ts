import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { EnvironmentQualificationEvidenceV1, EscalationRequest, Pod } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationDigest } from '../configuration/configuration-digest.js';
import {
  checkpointError,
  checkpointHash,
  createRetainedCheckpointRepository,
} from './retained-checkpoint-repository.js';

const processEpoch = randomUUID();
const scopes = new WeakMap<Database.Database, AsyncLocalStorage<string>>();
function scope(db: Database.Database) {
  let value = scopes.get(db);
  if (!value) {
    value = new AsyncLocalStorage<string>();
    scopes.set(db, value);
  }
  return value;
}
export interface CodingFinalSource {
  runId: string;
  generation: number;
  cycle: number;
  containerId: string;
  resourceKey: string;
  inputHead: string;
  head: string;
  tree: string;
  baseCommitSha: string;
  snapshot: string;
  sealedAt: string;
  reportsHash: string;
}
export interface CodingFacts {
  entered: { processEpoch: string; resourceIdentity: string };
  candidate: { containerId: string; generation: number; expectedImage: string };
  probing: { processEpoch: string };
  qualified: {
    processEpoch: string;
    expiresAt: string;
    evidence: EnvironmentQualificationEvidenceV1;
  };
  worker: { runId: string; cycle: number; providerOrdinal: number };
  final_source: CodingFinalSource;
  blocked: { code: string };
}
export interface CodingBinding {
  version: 1;
  mode: 'qualify_then_code_once';
  reportSetHash: string;
  requirementsHash: string;
  parentDigest: string;
  executionDigest: string;
  bindingDigest: string;
}
export interface RetainedCodingRecord {
  id: string;
  podId: string;
  requestHash: string;
  request: unknown;
  context: Pick<
    Pod,
    | 'taskSummary'
    | 'plan'
    | 'progress'
    | 'claudeSessionId'
    | 'codexSessionId'
    | 'piSessionId'
    | 'completedAt'
    | 'lastCorrectionMessage'
    | 'failureReason'
    | 'readinessReview'
    | 'artifactsPath'
    | 'previewUrl'
    | 'finalization'
    | 'lastRecoveryTrigger'
    | 'reworkReason'
    | 'pauseReason'
    | 'infrastructureFailure'
  >;
  binding: CodingBinding;
  facts: Partial<CodingFacts>;
  createdAt: string;
}
export function createRetainedCodingRepository(db: Database.Database) {
  function get(id: string): RetainedCodingRecord | null {
    const row = db
      .prepare(`SELECT recovery_id AS id,pod_id AS podId,request_hash AS requestHash,
      request,original_context AS context,binding,created_at AS createdAt FROM retained_coding_continuations WHERE recovery_id=?`)
      .get(id) as
      | (Omit<RetainedCodingRecord, 'request' | 'context' | 'binding' | 'facts'> & {
          request: string;
          context: string;
          binding: string;
        })
      | undefined;
    if (!row) return null;
    const facts = Object.fromEntries(
      (
        db
          .prepare('SELECT kind,evidence FROM retained_coding_facts WHERE recovery_id=?')
          .all(id) as { kind: string; evidence: string }[]
      ).map((r) => [r.kind, JSON.parse(r.evidence)]),
    ) as Partial<CodingFacts>;
    return {
      ...row,
      request: JSON.parse(row.request),
      context: JSON.parse(row.context),
      binding: JSON.parse(row.binding),
      facts,
    };
  }
  function latest(podId: string) {
    const row = db
      .prepare(
        `SELECT recovery_id AS id FROM retained_coding_continuations WHERE pod_id=? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(podId) as { id: string } | undefined;
    return row ? get(row.id) : null;
  }
  function append<K extends keyof CodingFacts>(id: string, kind: K, evidence: CodingFacts[K]) {
    const record = get(id) ?? checkpointError('Coding custody unavailable');
    if (record.facts.blocked || record.facts[kind])
      checkpointError('Coding step already entered; observe the saved operation');
    db.prepare('INSERT INTO retained_coding_facts VALUES(?,?,?,?)').run(
      id,
      kind,
      JSON.stringify(evidence),
      new Date().toISOString(),
    );
  }
  function assertOwned(podId: string) {
    const record = latest(podId) ?? checkpointError('Coding operation unavailable');
    const parent = db
      .prepare(`SELECT p.lifecycle_generation AS generation,p.container_id AS containerId,p.worktree_path AS worktreePath,
      e.evidence AS activation,s.evidence AS preparation FROM pods p
      JOIN retained_checkpoint_recovery_events e ON e.recovery_id=? AND e.kind='activated'
      JOIN retained_checkpoint_recovery_events s ON s.recovery_id=e.recovery_id AND s.kind='prepared' WHERE p.id=?`)
      .get(record.id, podId) as
      | {
          generation: number;
          containerId: string | null;
          worktreePath: string;
          activation: string;
          preparation: string;
        }
      | undefined;
    if (
      record.binding.version !== 1 ||
      record.binding.mode !== 'qualify_then_code_once' ||
      scope(db).getStore() !== record.id ||
      record.facts.blocked ||
      !parent ||
      JSON.parse(parent.activation).generation !== parent.generation ||
      JSON.parse(parent.preparation).worktree !== parent.worktreePath ||
      record.facts.entered?.processEpoch !== processEpoch ||
      (record.facts.candidate &&
        (record.facts.candidate.containerId !== parent.containerId ||
          record.facts.candidate.generation !== parent.generation))
    )
      checkpointError(
        'Retained coding ownership changed or interrupted',
        'REPAIR_CONTINUATION_STALE',
      );
    return record;
  }
  function assertQualified(podId: string, allowWorker = false) {
    const record = assertOwned(podId);
    const proof = record.facts.qualified;
    if (
      !proof ||
      proof.evidence.outcome !== 'qualified' ||
      proof.evidence.bindingDigest !== configurationDigest(proof.evidence.binding) ||
      proof.processEpoch !== processEpoch ||
      Date.parse(proof.expiresAt) <= Date.now() ||
      !record.facts.candidate ||
      record.facts.final_source ||
      (!allowWorker && record.facts.worker)
    )
      checkpointError(
        'Exact fresh qualification and unused coding admission required',
        'REPAIR_QUALIFICATION_UNAVAILABLE',
      );
    return record;
  }
  return {
    get,
    latest,
    append,
    assertOwned,
    assertQualified,
    reports(podId: string, generation: number) {
      const rows = db
        .prepare(`SELECT substr(id,1,129) AS id,substr(created_at,1,129) AS timestamp,substr(payload,1,65537) AS payload,CASE WHEN response IS NULL THEN NULL ELSE 'present' END AS response FROM escalations
        WHERE pod_id=? AND type='report_blocker' AND json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.kind')='infrastructure'
        AND json_extract(CASE WHEN json_valid(payload) THEN payload END,'$.lifecycleGeneration')=? ORDER BY created_at,id LIMIT 101`)
        .all(podId, generation) as {
        id: string;
        timestamp: string;
        payload: string;
        response: string | null;
      }[];
      if (
        !rows.length ||
        rows.length > 100 ||
        rows.some(
          (r) =>
            r.id.length > 128 ||
            r.timestamp.length > 128 ||
            r.response !== null ||
            Buffer.byteLength(r.payload) > 65536,
        ) ||
        rows.reduce((n, r) => n + Buffer.byteLength(r.payload), 0) > 1048576
      )
        checkpointError(
          'A complete bounded infrastructure report set is required',
          'REPAIR_REPORTS_UNAVAILABLE',
        );
      const reports = rows.map((r) => ({
        ...r,
        podId,
        type: 'report_blocker' as const,
        payload: JSON.parse(r.payload),
        response: null,
      })) as EscalationRequest[];
      return { reports, hash: configurationDigest(reports) };
    },
    processEpoch,
    owned<T>(id: string, run: () => T): T {
      return scope(db).run(id, run);
    },
    isOwner(podId: string): boolean {
      const record = latest(podId);
      return !!record && scope(db).getStore() === record.id;
    },
    claim(id: string, pod: Pod, request: unknown, requestHash: string, binding: CodingBinding) {
      if (!db.inTransaction)
        checkpointError('Coding claim must share original custody transaction');
      const {
        taskSummary,
        plan,
        progress,
        claudeSessionId,
        codexSessionId,
        piSessionId,
        completedAt,
        lastCorrectionMessage,
        failureReason,
        readinessReview,
      } = pod;
      db.prepare('INSERT INTO retained_coding_continuations VALUES(?,?,?,?,?,?,?)').run(
        id,
        pod.id,
        requestHash,
        JSON.stringify(request),
        JSON.stringify({
          taskSummary,
          plan,
          progress,
          claudeSessionId,
          codexSessionId,
          piSessionId,
          completedAt,
          lastCorrectionMessage,
          failureReason,
          readinessReview,
          artifactsPath: pod.artifactsPath,
          previewUrl: pod.previewUrl,
          finalization: pod.finalization,
          lastRecoveryTrigger: pod.lastRecoveryTrigger,
          reworkReason: pod.reworkReason,
          pauseReason: pod.pauseReason,
          infrastructureFailure: pod.infrastructureFailure,
        }),
        JSON.stringify(binding),
        new Date().toISOString(),
      );
    },
    enter(id: string, resourceIdentity: string) {
      append(id, 'entered', { processEpoch, resourceIdentity });
    },
    assertWorkerAllowed(podId: string) {
      assertQualified(podId);
    },
    assertCompletedWorker(podId: string) {
      const record = assertOwned(podId);
      const worker = record.facts.worker ?? checkpointError('Coding run missing');
      const settled = db
        .prepare(`SELECT 1 FROM task_agent_runs r JOIN task_retry_attempts a ON a.id=r.id
        JOIN provider_attempts p ON p.pod_id=r.pod_id AND p.ordinal=?
        WHERE r.id=? AND r.pod_id=? AND r.ended_at IS NOT NULL AND r.outcome='completed'
        AND r.failure_category IS NOT 'execution_termination_unverified' AND a.ended_at IS NOT NULL AND a.outcome='pass'
        AND p.ended_at IS NOT NULL AND p.outcome='completed'`)
        .get(worker.providerOrdinal, worker.runId, podId);
      if (!settled)
        checkpointError(
          'Positive exact worker/retry/provider settlement required',
          'REPAIR_WORKER_UNSETTLED',
        );
    },
    bindWorker(podId: string, runId: string, cycle: number, providerOrdinal: number) {
      const record = assertQualified(podId);
      if (!db.inTransaction || !Number.isInteger(providerOrdinal))
        checkpointError('Atomic coding run and provider segment required');
      append(record.id, 'worker', { runId, cycle, providerOrdinal });
    },
    withWorkerScope<T>(podId: string, run: () => T): T {
      const record = latest(podId);
      if (!record) return run();
      const worker = record.facts.worker;
      if (
        !worker ||
        record.facts.final_source ||
        record.facts.blocked ||
        record.facts.entered?.processEpoch !== processEpoch ||
        !db
          .prepare(
            `SELECT 1 FROM task_agent_runs r JOIN pods p ON p.id=r.pod_id WHERE r.id=? AND r.pod_id=? AND r.ended_at IS NULL AND r.failure_category IS NOT 'execution_termination_unverified' AND p.status IN ('running','awaiting_input') AND r.generation=p.lifecycle_generation AND p.container_id=?`,
          )
          .get(worker.runId, podId, record.facts.candidate?.containerId)
      )
        checkpointError('No current retained coding worker owns this MCP request');
      return createRetainedCheckpointRepository(db).owned(record.id, () =>
        scope(db).run(record.id, run),
      );
    },
    assertMutationAllowed(containerId: string) {
      const row = db
        .prepare(
          `SELECT r.pod_id AS podId FROM retained_coding_continuations r JOIN retained_coding_facts f ON f.recovery_id=r.recovery_id WHERE f.kind='candidate' AND json_extract(f.evidence,'$.containerId')=?`,
        )
        .get(containerId) as { podId: string } | undefined;
      if (row) assertOwned(row.podId);
    },
    retains(containerId: string) {
      return !!db
        .prepare(
          `SELECT 1 FROM retained_coding_facts WHERE kind='candidate' AND json_extract(evidence,'$.containerId')=?`,
        )
        .get(containerId);
    },
    sessionNamespace(podId: string) {
      const record = latest(podId);
      const current = db
        .prepare('SELECT lifecycle_generation AS generation FROM pods WHERE id=?')
        .get(podId) as { generation: number } | undefined;
      const active =
        record &&
        (db
          .prepare(
            "SELECT evidence FROM retained_checkpoint_recovery_events WHERE recovery_id=? AND kind='activated'",
          )
          .get(record.id) as { evidence: string } | undefined);
      return record &&
        current &&
        active &&
        JSON.parse(active.evidence).generation === current.generation
        ? `${podId}-repair-${record.id}`
        : podId;
    },
    finalSource(podId: string, generation: number) {
      const source = latest(podId)?.facts.final_source;
      return source?.generation === generation ? source : null;
    },
    requestHash(podId: string, request: unknown, actor: unknown) {
      return checkpointHash([podId, request, actor]);
    },
  };
}
export type RetainedCodingRepository = ReturnType<typeof createRetainedCodingRepository>;
