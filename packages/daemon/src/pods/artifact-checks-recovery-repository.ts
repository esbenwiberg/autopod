import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { AutopodError, type Pod } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { retainedPathIdentity } from './retained-path-identity.js';

export function artifactChecksError(message: string): never {
  throw new AutopodError(message, 'ARTIFACT_CHECKS_RECOVERY_BLOCKED', 409);
}
export interface ArtifactChecksBinding {
  podId: string;
  taskId: string;
  generation: number;
  cycle: number;
  containerId: string;
  resourceKey: string;
  authorityHash: string;
  reportsHash: string;
}
export interface ArtifactChecksRecord {
  id: string;
  binding: ArtifactChecksBinding;
  requestHash: string;
  events: Record<string, unknown>;
}
const scopes = new WeakMap<Database.Database, AsyncLocalStorage<string>>();
const executions = new WeakMap<Database.Database, AsyncLocalStorage<string>>();
function scope(db: Database.Database) {
  let value = scopes.get(db);
  if (!value) {
    value = new AsyncLocalStorage<string>();
    scopes.set(db, value);
  }
  return value;
}
// A reviewer capability exists only on the admitted controller's async execution.
const reviews = new AsyncLocalStorage<() => Pod>();
export function artifactChecksReviewAllowed(pod: Pod): boolean {
  const owner = reviews.getStore();
  if (!owner) return false;
  const current = owner();
  return (
    current.id === pod.id &&
    current.lifecycleGeneration === pod.lifecycleGeneration &&
    current.launchConfigDigest === pod.launchConfigDigest
  );
}
export function withArtifactChecksReview<T>(assertCurrent: () => Pod, run: () => T): T {
  return reviews.run(assertCurrent, run);
}
export function assertArtifactChecksResourceAvailable(
  db: Database.Database,
  id: string,
  allowExecution = false,
): void {
  if (db.prepare('SELECT 1 FROM artifact_checks_recoveries WHERE container_id=?').get(id))
    artifactChecksError('Original artifact resource remains in checks-only custody');
  const candidate = db
    .prepare(`SELECT r.id FROM artifact_checks_recoveries r JOIN artifact_checks_recovery_events e
    ON e.recovery_id=r.id AND e.kind='allocated' WHERE json_extract(e.evidence,'$.containerId')=?`)
    .get(id) as { id: string } | undefined;
  if (candidate) {
    const record = createArtifactChecksRecoveryRepository(db).get(candidate.id)!;
    if (
      !allowExecution ||
      executions.get(db)?.getStore() !== candidate.id ||
      record.events.blocked ||
      record.events.checked
    )
      artifactChecksError('Independent artifact checks resource remains in custody');
  }
}
export function ownsArtifactChecksStop(db: Database.Database, containerId: string): boolean {
  const id = scope(db).getStore();
  if (!id) return false;
  const record = createArtifactChecksRecoveryRepository(db).get(id);
  return (
    record?.binding.containerId === containerId &&
    Boolean(record.events.stopDispatched) &&
    !record.events.stopped &&
    !record.events.blocked
  );
}
export function ownsArtifactChecksArchive(
  db: Database.Database,
  containerId: string,
  location: string,
): boolean {
  const id = scope(db).getStore();
  const record = id ? createArtifactChecksRecoveryRepository(db).get(id) : null;
  return (
    location === '/workspace' &&
    record?.binding.containerId === containerId &&
    Boolean(record.events.stopped) &&
    Boolean(record.events.captureDispatched) &&
    !record.events.captured &&
    !record.events.blocked
  );
}
export function assertArtifactChecksAvailable(db: Database.Database, podId: string): void {
  if (
    db
      .prepare(`SELECT 1 FROM artifact_checks_recoveries WHERE pod_id=? OR
    task_id=(SELECT task_id FROM task_executions WHERE pod_id=?) OR
    container_id=(SELECT container_id FROM pods WHERE id=?)`)
      .get(podId, podId, podId)
  )
    artifactChecksError(
      'Checks-only artifact recovery owns this task; inspect its recorded outcome',
    );
}
export function assertArtifactChecksPathAvailable(db: Database.Database, location: string): void {
  const rows = db
    .prepare(
      "SELECT json_extract(evidence,'$.root') AS root FROM artifact_checks_recovery_events WHERE kind='storage'",
    )
    .all() as { root: string }[];
  const candidates = [path.resolve(location), retainedPathIdentity(location)];
  for (const { root } of rows)
    for (const held of [path.resolve(root), retainedPathIdentity(root)])
      if (
        candidates.some(
          (candidate) =>
            candidate === held ||
            candidate.startsWith(`${held}${path.sep}`) ||
            held.startsWith(`${candidate}${path.sep}`),
        )
      )
        artifactChecksError(
          'Artifact recovery snapshot, reports and execution storage remain retained',
        );
}
export function createArtifactChecksRecoveryRepository(
  db: Database.Database,
): ArtifactChecksRecoveryRepository {
  function get(id: string): ArtifactChecksRecord | null {
    const row = db
      .prepare('SELECT binding,request_hash FROM artifact_checks_recoveries WHERE id=?')
      .get(id) as { binding: string; request_hash: string } | undefined;
    if (!row) return null;
    const events = db
      .prepare('SELECT kind,evidence FROM artifact_checks_recovery_events WHERE recovery_id=?')
      .all(id) as { kind: string; evidence: string }[];
    return {
      id,
      binding: JSON.parse(row.binding),
      requestHash: row.request_hash,
      events: Object.fromEntries(events.map((e) => [e.kind, JSON.parse(e.evidence)])),
    };
  }
  return {
    get,
    assertAvailable: (podId: string) => assertArtifactChecksAvailable(db, podId),
    forPod(podId: string) {
      const row = db
        .prepare('SELECT id FROM artifact_checks_recoveries WHERE pod_id=?')
        .get(podId) as { id: string } | undefined;
      return row ? get(row.id) : null;
    },
    admit: db.transaction(
      (
        id: string,
        binding: ArtifactChecksBinding,
        requestHash: string,
        assertCurrent: () => void,
        audit: unknown,
      ) => {
        const prior = get(id);
        if (prior) {
          if (
            prior.requestHash !== requestHash ||
            configurationDigest(prior.binding) !== configurationDigest(binding)
          )
            artifactChecksError(
              'Request identity already belongs to a different selection or actor',
            );
          return prior;
        }
        assertCurrent();
        db.prepare('INSERT INTO artifact_checks_recoveries VALUES(?,?,?,?,?,?,?)').run(
          id,
          binding.podId,
          binding.taskId,
          binding.containerId,
          requestHash,
          JSON.stringify(binding),
          new Date().toISOString(),
        );
        db.prepare('INSERT INTO artifact_checks_recovery_events VALUES(?,?,?,?)').run(
          id,
          'selected',
          JSON.stringify(audit),
          new Date().toISOString(),
        );
        return get(id)!;
      },
    ),
    append(id: string, kind: string, evidence: unknown) {
      db.prepare('INSERT INTO artifact_checks_recovery_events VALUES(?,?,?,?)').run(
        id,
        kind,
        JSON.stringify(evidence),
        new Date().toISOString(),
      );
    },
    stop<T>(id: string, run: () => T): T {
      return scope(db).run(id, run);
    },
    execute<T>(id: string, run: () => T): T {
      let owner = executions.get(db);
      if (!owner) {
        owner = new AsyncLocalStorage<string>();
        executions.set(db, owner);
      }
      return owner.run(id, run);
    },
  };
}
export interface ArtifactChecksRecoveryRepository {
  get(id: string): ArtifactChecksRecord | null;
  forPod(podId: string): ArtifactChecksRecord | null;
  admit(
    id: string,
    binding: ArtifactChecksBinding,
    requestHash: string,
    assertCurrent: () => void,
    audit: unknown,
  ): ArtifactChecksRecord;
  append(id: string, kind: string, evidence: unknown): void;
  stop<T>(id: string, run: () => T): T;
  execute<T>(id: string, run: () => T): T;
  assertAvailable(podId: string): void;
}
