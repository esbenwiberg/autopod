import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AutopodError, type StalledWorkerRecoveryReceipt } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { assertArtifactChecksAvailable } from './artifact-checks-recovery-repository.js';
import { hasUnansweredDecision } from './decision-admission.js';

export const stalledHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function stalledError(message: string): never {
  throw new AutopodError(message, 'STALLED_WORKER_RECOVERY_BLOCKED', 409);
}
export interface StalledRun {
  id: string;
  podId: string;
  generation: number;
  cycle: number;
  binding: string;
  outcome: string | null;
  failureCategory: string | null;
}
export interface StalledBinding {
  fingerprint: string;
  run: StalledRun;
  resourceKey: string;
  hostSource: unknown;
}
export interface StalledRecord {
  receipt: StalledWorkerRecoveryReceipt;
  hash: string;
  binding: StalledBinding;
  archivePath: string;
  stopDispatched: boolean;
  archivedSource: unknown | null;
  archiveFingerprint: { sha256: string; entries: number; bytes: number } | null;
}
const scopes = new WeakMap<
  Database.Database,
  AsyncLocalStorage<{
    podId: string;
    kind: 'stop' | 'preserve' | 'settle';
  }>
>();
function scope(db: Database.Database) {
  let value = scopes.get(db);
  if (!value) {
    value = new AsyncLocalStorage();
    scopes.set(db, value);
  }
  return value;
}
export function assertStalledRecoveryAvailable(
  db: Database.Database,
  podId: string,
  preservation = false,
) {
  const own = scope(db).getStore();
  if (
    own?.podId === podId &&
    ((own.kind === 'settle' && db.inTransaction) || (preservation && own.kind === 'preserve'))
  )
    return;
  const row = db
    .prepare(`SELECT 1 FROM stalled_worker_recoveries r WHERE json_extract(r.receipt,'$.state')='pending'
    AND (r.pod_id=? OR r.task_id=(SELECT task_id FROM task_executions WHERE pod_id=?)
    OR r.container_id=(SELECT container_id FROM pods WHERE id=?)
    OR json_extract(r.original_evidence,'$.pod.worktreePath')=(SELECT worktree_path FROM pods WHERE id=?))`)
    .get(podId, podId, podId, podId);
  if (row)
    stalledError(
      'A saved stop-and-retain request owns this task. Inspect and reconcile that exact request; no competing mutation is allowed.',
    );
}
export function assertStalledRecoveryResourceAvailable(db: Database.Database, containerId: string) {
  if (
    db
      .prepare(
        `SELECT 1 FROM stalled_worker_recoveries WHERE container_id=? AND json_extract(receipt,'$.state')='pending'`,
      )
      .get(containerId)
  )
    stalledError(
      'Stop-and-retain owns this exact resource; no wake, exec, cleanup or replacement is authorized.',
    );
}
export function assertStalledRecoveryPathAvailable(db: Database.Database, location: string) {
  const candidate = path.resolve(location);
  for (const row of db
    .prepare('SELECT archive_path AS location FROM stalled_worker_recoveries')
    .all() as { location: string }[]) {
    const held = path.resolve(row.location);
    if (
      candidate === held ||
      candidate.startsWith(`${held}${path.sep}`) ||
      held.startsWith(`${candidate}${path.sep}`)
    )
      stalledError('An immutable stop-and-retain workspace archive occupies this location.');
  }
}
/** Read-only getArchive capability for the owned preservation routine; never exec/start/kill. */
export function ownsStalledWorkerArchive(
  db: Database.Database,
  containerId: string,
  containerPath: string,
) {
  const own = scope(db).getStore();
  return (
    own?.kind === 'preserve' &&
    ['/workspace', '/workspace/.git'].includes(containerPath) &&
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM stalled_worker_recoveries WHERE pod_id=? AND container_id=? AND json_extract(receipt,'$.state')='pending'",
        )
        .get(own.podId, containerId),
    )
  );
}
export function ownsStalledWorkerStop(db: Database.Database, containerId: string) {
  const own = scope(db).getStore();
  return (
    own?.kind === 'stop' &&
    Boolean(
      db
        .prepare(
          `SELECT 1 FROM stalled_worker_recoveries WHERE pod_id=? AND container_id=? AND stop_dispatched=1 AND json_extract(receipt,'$.state')='pending'`,
        )
        .get(own.podId, containerId),
    )
  );
}
export function createStalledWorkerRecoveryRepository(db: Database.Database) {
  const decode = (row: Record<string, unknown> | undefined): StalledRecord | null =>
    row
      ? {
          receipt: JSON.parse(String(row.receipt)),
          hash: String(row.request_hash),
          binding: JSON.parse(String(row.binding)),
          archivePath: String(row.archive_path),
          stopDispatched: Boolean(row.stop_dispatched),
          archivedSource: row.preservation
            ? (JSON.parse(String(row.preservation)).archivedSource ?? null)
            : null,
          archiveFingerprint: row.preservation
            ? (JSON.parse(String(row.preservation)).archiveFingerprint ?? null)
            : null,
        }
      : null;
  const get = (key: string) =>
    decode(
      db.prepare('SELECT * FROM stalled_worker_recoveries WHERE request_key=?').get(key) as
        | Record<string, unknown>
        | undefined,
    );
  const latest = (podId: string) =>
    decode(
      db
        .prepare(
          'SELECT * FROM stalled_worker_recoveries WHERE pod_id=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(podId) as Record<string, unknown> | undefined,
    );
  const unsettled = (podId: string) =>
    db
      .prepare(
        `SELECT r.id,r.pod_id AS podId,r.generation,r.cycle,r.binding,r.outcome,r.failure_category AS failureCategory FROM task_agent_runs r JOIN task_executions e ON e.pod_id=r.pod_id WHERE e.task_id=(SELECT task_id FROM task_executions WHERE pod_id=?) AND r.ended_at IS NULL ORDER BY r.started_at,r.id`,
      )
      .all(podId) as StalledRun[];
  return {
    get,
    latest,
    unsettled,
    pendingMessage(key: string, message: string) {
      const row = get(key);
      if (!row || row.receipt.state !== 'pending') return;
      db.prepare('UPDATE stalled_worker_recoveries SET receipt=? WHERE request_key=?').run(
        JSON.stringify({ ...row.receipt, message }),
        key,
      );
    },
    recordArchive(
      key: string,
      archivedSource: unknown,
      archiveFingerprint: NonNullable<StalledRecord['archiveFingerprint']>,
    ) {
      const row = get(key);
      if (!row || row.receipt.state !== 'pending')
        stalledError('Exact pending archive owner required.');
      if (row.archivedSource && stalledHash(row.archivedSource) !== stalledHash(archivedSource))
        stalledError('Recorded workspace archive changed.');
      if (!row.archivedSource)
        db.prepare('UPDATE stalled_worker_recoveries SET preservation=? WHERE request_key=?').run(
          JSON.stringify({ archivedSource, archiveFingerprint }),
          key,
        );
    },
    hasPendingDecision: (podId: string) => hasUnansweredDecision(db, podId),
    assertOtherAdmissionsSettled(podId: string, runId: string) {
      const task = db
        .prepare('SELECT task_id AS id FROM task_executions WHERE pod_id=?')
        .get(podId) as { id: string };
      if (
        db
          .prepare(
            "SELECT 1 FROM task_retry_attempts WHERE task_id=? AND ended_at IS NULL AND NOT(stage='worker' AND id=?)",
          )
          .get(task.id, runId)
      )
        stalledError('Another task-wide worker/startup/validation admission is unresolved.');
      if (
        db
          .prepare(
            'SELECT 1 FROM source_publication_intents i LEFT JOIN source_publication_receipts r ON r.intent_id=i.id WHERE i.task_id=? AND r.intent_id IS NULL',
          )
          .get(task.id) ||
        db
          .prepare(
            "SELECT 1 FROM delivery_intents WHERE task_id=? AND state IN ('creating','uncertain')",
          )
          .get(task.id) ||
        db
          .prepare(
            "SELECT 1 FROM merge_intents i JOIN merge_attempts a ON a.intent_id=i.id WHERE i.task_id=? AND NOT EXISTS(SELECT 1 FROM merge_observations o WHERE o.intent_id=i.id AND o.disposition='merged')",
          )
          .get(task.id)
      )
        stalledError('Publication, PR or merge ownership requires its separate reconciliation.');
    },
    reports: (podId: string) =>
      db
        .prepare(
          `SELECT id,type,payload,created_at FROM escalations WHERE pod_id=? AND type='report_blocker' ORDER BY created_at,id`,
        )
        .all(podId),
    assertAvailable: (podId: string) => assertStalledRecoveryAvailable(db, podId),
    admit(record: StalledRecord, taskId: string, containerId: string, evidence: unknown) {
      assertArtifactChecksAvailable(db, record.receipt.podId);
      assertStalledRecoveryAvailable(db, record.receipt.podId);
      db.prepare(
        `INSERT INTO stalled_worker_recoveries(request_key,pod_id,task_id,container_id,request_hash,binding,receipt,archive_path,original_evidence) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        record.receipt.request.requestKey,
        record.receipt.podId,
        taskId,
        containerId,
        record.hash,
        JSON.stringify(record.binding),
        JSON.stringify(record.receipt),
        record.archivePath,
        JSON.stringify(evidence),
      );
    },
    dispatchStop<T>(record: StalledRecord, stop: () => T): T {
      const change = db
        .prepare(
          `UPDATE stalled_worker_recoveries SET stop_dispatched=1 WHERE request_key=? AND stop_dispatched=0 AND json_extract(receipt,'$.state')='pending'`,
        )
        .run(record.receipt.request.requestKey);
      if (change.changes !== 1)
        stalledError('Stop was already dispatched; observe the saved operation.');
      return scope(db).run({ podId: record.receipt.podId, kind: 'stop' }, stop);
    },
    preserve<T>(podId: string, work: () => T): T {
      return scope(db).run({ podId, kind: 'preserve' }, work);
    },
    settle<T>(
      record: StalledRecord,
      preservation: unknown,
      work: () => T,
    ): StalledWorkerRecoveryReceipt {
      if (!db.inTransaction) stalledError('Atomic settlement required.');
      const saved = get(record.receipt.request.requestKey);
      if (!saved || saved.hash !== record.hash || saved.receipt.state !== 'pending')
        stalledError('Exact pending recovery required.');
      const runs = unsettled(record.receipt.podId);
      if (runs.length !== 1 || stalledHash(runs[0]) !== stalledHash(record.binding.run))
        stalledError('Original worker run changed before settlement.');
      // Ended_at is positive resource settlement, NOT an observed worker exit code or success.
      db.prepare('UPDATE task_agent_runs SET ended_at=? WHERE id=? AND ended_at IS NULL').run(
        new Date().toISOString(),
        record.binding.run.id,
      );
      db.prepare(
        "UPDATE task_retry_attempts SET ended_at=?,outcome='unknown',measured_duration_ms=NULL WHERE id=? AND stage='worker' AND ended_at IS NULL",
      ).run(new Date().toISOString(), record.binding.run.id);
      scope(db).run({ podId: record.receipt.podId, kind: 'settle' }, work);
      const receipt: StalledWorkerRecoveryReceipt = {
        ...saved.receipt,
        state: 'settled',
        settledAt: new Date().toISOString(),
        message:
          'Docker execution stopped and workspace archived. Original source, resource, reports and failed checks retained. Choose validation recovery separately; no pass, retry or delivery was requested.',
      };
      db.prepare(
        'UPDATE stalled_worker_recoveries SET receipt=?,preservation=? WHERE request_key=?',
      ).run(
        JSON.stringify(receipt),
        JSON.stringify(preservation),
        record.receipt.request.requestKey,
      );
      return receipt;
    },
  };
}
export type StalledWorkerRecoveryRepository = ReturnType<
  typeof createStalledWorkerRecoveryRepository
>;
