import path from 'node:path';
import {
  AutopodError,
  PodNotFoundError,
  type RetainedCleanupBlocker,
  type RetainedCleanupPlan,
  type RetainedCleanupReceipt,
  type RetainedCleanupRequest,
  type RetainedCleanupResource,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { GitWorktreeIdentity, PhysicalIdentity } from './retained-allocation-inventory.js';
import { retainedPathIdentity } from './retained-path-identity.js';
import { createTaskHistoryArchive } from './task-history-archive.js';

export const overlaps = (a: string, b: string) =>
  a === b ||
  a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) ||
  b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);

export function cleanupConflict(message: string): never {
  throw new AutopodError(message, 'RETAINED_CLEANUP_CONFLICT', 409);
}

const migrated = new WeakSet<Database.Database>();
export function hasRetainedCleanupSchema(db: Database.Database) {
  if (!migrated.has(db)) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='retained_cleanup_requests'").get())
      return false;
    migrated.add(db);
  }
  return true;
}

export function assertRetainedCleanupAvailable(db: Database.Database, podId: string) {
  if (!hasRetainedCleanupSchema(db)) return;
  if (
    db
      .prepare(`SELECT 1 FROM retained_cleanup_requests WHERE pod_id=? OR task_id=
    (SELECT task_id FROM task_executions WHERE pod_id=?)`)
      .get(podId, podId)
  )
    cleanupConflict(
      'Delete & free resources owns this exact task. Observe its retained cleanup receipt.',
    );
}

export function assertRetainedCleanupResourceAvailable(db: Database.Database, id: string) {
  if (!hasRetainedCleanupSchema(db)) return;
  if (
    db
      .prepare(`SELECT 1 FROM retained_cleanup_targets t JOIN retained_cleanup_held h ON h.id=t.request_id
    WHERE t.kind='docker_container' AND t.identity=?`)
      .get(id)
  )
    cleanupConflict('Delete & free resources owns this exact container.');
}

export function assertRetainedCleanupBridgeAvailable(db: Database.Database, name: string) {
  if (!hasRetainedCleanupSchema(db)) return;
  if (
    db
      .prepare(`SELECT 1 FROM retained_finalizations f, json_each(f.delivery_evidence,'$.targets') t
    WHERE json_extract(f.delivery_evidence,'$.kind')='validation-held-docker'
      AND json_extract(t.value,'$.kind')='docker_bridge'
      AND (json_extract(t.value,'$.id')=? OR json_extract(t.value,'$.name')=?)`)
      .get(name, name)
  )
    cleanupConflict('Validation-held Stop retains this exact bridge.');
  if (
    db
      .prepare(`SELECT 1 FROM retained_cleanup_targets t JOIN retained_cleanup_held h ON h.id=t.request_id
    JOIN json_each(h.binding,'$.targets') j ON j.key=t.ordinal
    WHERE t.kind='docker_bridge' AND (t.identity=? OR json_extract(j.value,'$.name')=?)`)
      .get(name, name)
  )
    cleanupConflict('Delete & free resources owns this exact bridge.');
}

export function assertRetainedCleanupPathAvailable(db: Database.Database, location: string) {
  if (!hasRetainedCleanupSchema(db)) return;
  const paths = db
    .prepare(`SELECT t.identity AS location FROM retained_cleanup_targets t
    JOIN retained_cleanup_held h ON h.id=t.request_id WHERE t.kind LIKE 'host_%'`)
    .all() as { location: string }[];
  if (
    paths.length &&
    paths.some((p) =>
      [path.resolve(location), retainedPathIdentity(location)].some((q) => overlaps(q, p.location)),
    )
  )
    cleanupConflict('Delete & free resources owns this host path.');
}

type AllocationTransport = { network?: string; sources: string[] };
const transports = new WeakMap<Database.Database, Set<AllocationTransport>>();
/** Managed creates are registered before their first await, closing the
 * not-yet-visible Docker list window for concurrent foreign allocations. */
export async function withCleanupAllocationFence<T>(
  db: Database.Database,
  podId: string,
  claim: AllocationTransport,
  run: () => Promise<T>,
) {
  assertRetainedCleanupAvailable(db, podId);
  if (claim.network) assertRetainedCleanupBridgeAvailable(db, claim.network);
  for (const source of claim.sources) assertRetainedCleanupPathAvailable(db, source);
  const active = transports.get(db) ?? new Set<AllocationTransport>();
  transports.set(db, active);
  active.add(claim);
  try {
    return await run();
  } finally {
    active.delete(claim);
  }
}

export type Target = Omit<RetainedCleanupResource, 'kind'> & { observedPodId?: string } & (
    | {
        kind: 'docker_container';
        attemptId: string;
        bridgeId: string;
        sourceMount: string;
        name: string;
      }
    | { kind: 'docker_bridge'; attemptId: string; name: string }
    | { kind: 'host_worktree'; git: GitWorktreeIdentity }
    | {
        kind: 'host_prepared_root';
        root: PhysicalIdentity;
        git: GitWorktreeIdentity;
        snapshotRoot: PhysicalIdentity;
        snapshot: PhysicalIdentity;
        receipt: PhysicalIdentity;
        bundle: PhysicalIdentity;
      }
  );

export type Selection = {
  plan: RetainedCleanupPlan;
  taskId: string;
  durable: string;
  targets: Target[];
  absentAtAdmission: string[];
};
type Actor = RetainedCleanupReceipt['actor'];
type Decision = {
  id: string;
  pod_id: string;
  task_id: string;
  request: string;
  actor: string;
  binding: string;
  created_at: string;
};

export function createRetainedCleanupRepository(db: Database.Database) {
  const archive = createTaskHistoryArchive(db);
  function get(id: string) {
    return db.prepare('SELECT * FROM retained_cleanup_requests WHERE id=?').get(id) as
      | Decision
      | undefined;
  }
  function forPod(id: string) {
    return db.prepare('SELECT * FROM retained_cleanup_requests WHERE pod_id=?').get(id) as
      | Decision
      | undefined;
  }
  function completed(id: string) {
    return db
      .prepare('SELECT recorded_at FROM retained_cleanup_completions WHERE request_id=?')
      .get(id) as { recorded_at: string } | undefined;
  }
  function has(id: string, ordinal: number, kind: 'dispatch' | 'absent') {
    return !!db
      .prepare('SELECT 1 FROM retained_cleanup_facts WHERE request_id=? AND ordinal=? AND kind=?')
      .get(id, ordinal, kind);
  }
  const readReceipt = db.transaction((row: Decision): RetainedCleanupReceipt => {
    const { plan } = JSON.parse(row.binding) as Selection;
    const done = completed(row.id);
    const facts = db
      .prepare('SELECT * FROM retained_cleanup_facts WHERE request_id=?')
      .all(row.id) as { ordinal: number; kind: 'dispatch' | 'absent'; recorded_at: string }[];
    const failure = db
      .prepare('SELECT * FROM retained_cleanup_blockers WHERE request_id=?')
      .get(row.id) as { blocker: string; recorded_at: string } | undefined;
    return {
      podId: row.pod_id,
      request: JSON.parse(row.request),
      actor: JSON.parse(row.actor),
      plan,
      createdAt: row.created_at,
      updatedAt:
        done?.recorded_at ??
        [row.created_at, ...facts.map((f) => f.recorded_at), failure?.recorded_at ?? '']
          .sort()
          .at(-1)!,
      state: done ? 'deleted' : facts.length || failure ? 'partial' : 'pending',
      resources: plan.resources.map((resource, ordinal) => ({
        ...resource,
        state: facts.some((f) => f.ordinal === ordinal && f.kind === 'absent')
          ? 'confirmed_absent'
          : facts.some((f) => f.ordinal === ordinal && f.kind === 'dispatch')
            ? 'removal_unconfirmed'
            : 'pending',
      })),
      blockers: !done && failure ? [JSON.parse(failure.blocker)] : [],
    };
  });
  return {
    get,
    forPod,
    completed,
    has,
    receipt: (row: Decision) => readReceipt(row),
    /** Membership, predecessor chain and pending transports are read unpaged. */
    context(podId: string) {
      return {
        membership: db
          .prepare('SELECT task_id,execution_id FROM task_executions WHERE pod_id=?')
          .get(podId) as { task_id: string; execution_id: string } | undefined,
        lineage: db
          .prepare(`SELECT r.id, r.generation, r.resource_key, r.container_id,
          (SELECT evidence FROM retained_checkpoint_recovery_events WHERE recovery_id=r.id AND kind='activated') AS activated,
          (SELECT evidence FROM retained_checkpoint_recovery_events WHERE recovery_id=r.id AND kind='checked') AS checked
          FROM retained_checkpoint_recoveries r WHERE r.pod_id=? ORDER BY r.generation`)
          .all(podId) as {
          id: string;
          generation: number;
          resource_key: string;
          container_id: string;
          activated: string | null;
          checked: string | null;
        }[],
        unsettled: !!db
          .prepare(`SELECT 1 FROM provider_attempts WHERE pod_id=? AND ended_at IS NULL
          UNION ALL SELECT 1 FROM task_retry_attempts WHERE pod_id=? AND ended_at IS NULL
          UNION ALL SELECT 1 FROM isolated_reviewer_runs WHERE pod_id=?
            AND (state IN ('preparing','running','uncertain') OR cleanup<>'clean')`)
          .get(podId, podId, podId),
        incompatible: !!db
          .prepare(`SELECT 1 FROM pods WHERE id<>? AND (
          linked_pod_id=? OR fix_pod_id=? OR depends_on_pod_id=? OR
          EXISTS(SELECT 1 FROM json_each(depends_on_pod_ids) WHERE value=?))
          UNION ALL SELECT 1 FROM stalled_worker_recoveries WHERE pod_id=?
          UNION ALL SELECT 1 FROM retained_coding_continuations WHERE pod_id=?
          UNION ALL SELECT 1 FROM sandbox_wakeup_intents WHERE pod_id=?
          UNION ALL SELECT 1 FROM source_adoptions WHERE pod_id=?
          UNION ALL SELECT 1 FROM recovery_forks WHERE parent_pod_id=?
          UNION ALL SELECT 1 FROM saved_work_draft_pr_operations WHERE pod_id=?`)
          .get(podId, podId, podId, podId, podId, podId, podId, podId, podId, podId, podId),
      };
    },
    heldHistory(podId: string) {
      const members = db
        .prepare(`SELECT * FROM task_executions WHERE task_id=
        (SELECT task_id FROM task_executions WHERE pod_id=?)`)
        .all(podId);
      const dispatches = db
        .prepare('SELECT binding FROM validation_dispatches WHERE pod_id=? ORDER BY rowid')
        .all(podId) as { binding: string }[];
      const extra = db
        .prepare(`SELECT 1 FROM approval_source_rewrites WHERE pod_id=?
        UNION ALL SELECT 1 FROM retained_checkpoint_recoveries WHERE pod_id=?
        UNION ALL SELECT 1 FROM artifact_checks_recoveries WHERE pod_id=?`)
        .all(podId, podId, podId);
      return { members, dispatches, extra };
    },
    assertForeignClaims(podId: string, containers: string[], locations: string[]) {
      const ids = JSON.stringify(containers);
      const foreign = db
        .prepare(`SELECT 1 FROM retained_checkpoint_recoveries WHERE pod_id<>? AND container_id IN (SELECT value FROM json_each(?))
        UNION ALL SELECT 1 FROM retained_finalization_resources WHERE pod_id<>? AND container_id IN (SELECT value FROM json_each(?))
        UNION ALL SELECT 1 FROM pods p, json_each(p.sidecar_container_ids) s WHERE p.id<>? AND s.value IN (SELECT value FROM json_each(?))
        UNION ALL SELECT 1 FROM source_publication_resources r JOIN source_publication_intents i ON r.intent_id=i.id
          WHERE i.pod_id<>? AND r.container_id IN (SELECT value FROM json_each(?))`)
        .get(podId, ids, podId, ids, podId, ids, podId, ids);
      const paths = db
        .prepare(`SELECT value AS location FROM retained_finalizations f,json_each(f.binding,'$.sourceLocations') WHERE f.pod_id<>?
        UNION SELECT worktree_path FROM retained_checkpoint_recoveries WHERE pod_id<>?
        UNION SELECT json_extract(e.evidence,'$.worktree') FROM retained_checkpoint_recovery_events e
          JOIN retained_checkpoint_recoveries r ON r.id=e.recovery_id WHERE r.pod_id<>? AND e.kind='prepared'
        UNION SELECT artifacts_path FROM pods WHERE id<>?`)
        .all(podId, podId, podId, podId) as { location: string | null }[];
      if (
        foreign ||
        paths.some(
          (p) =>
            p.location &&
            [path.resolve(p.location), retainedPathIdentity(p.location)].some((q) =>
              locations.some((l) => overlaps(q, l)),
            ),
        )
      )
        cleanupConflict('Foreign task custody overlaps a selected resource.');
    },
    assertAllocationTransportsSettled(networks: string[], locations: string[]) {
      for (const active of transports.get(db) ?? [])
        if (
          (active.network && networks.includes(active.network)) ||
          active.sources.some((s) =>
            [path.resolve(s), retainedPathIdentity(s)].some((q) =>
              locations.some((l) => overlaps(q, l)),
            ),
          )
        )
          cleanupConflict(
            'A managed Docker allocation may attach selected source or bridge resources.',
          );
    },
    assertNetworkReleaseSettled(podId: string, bridges: string[]) {
      if (
        db
          .prepare(`SELECT 1 FROM retained_network_releases r
        WHERE (r.owner_pod_id=? OR r.network_id IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS(SELECT 1 FROM retained_network_release_outcomes o WHERE o.release_id=r.id AND o.outcome IN ('removed','already_absent'))`)
          .get(podId, JSON.stringify(bridges))
      )
        cleanupConflict('An exact retained bridge release has no confirmed removal outcome.');
    },
    foreignAllocations(taskId: string) {
      return db
        .prepare(`SELECT a.role, a.locator, f.kind, f.evidence FROM retained_allocation_attempts a
        LEFT JOIN retained_allocation_facts f ON f.attempt_id=a.id AND f.kind IN ('owned','create-reply')
        WHERE a.task_id<>?`)
        .all(taskId) as {
        role: string;
        locator: string;
        kind: string | null;
        evidence: string | null;
      }[];
    },
    admit: db.transaction(
      (
        podId: string,
        request: RetainedCleanupRequest,
        actor: Actor,
        s: Selection,
        guard: () => void,
      ) => {
        guard();
        if (get(request.id) || forPod(podId))
          cleanupConflict('Request or pod already has an admitted cleanup.');
        db.prepare('INSERT INTO retained_cleanup_requests VALUES (?,?,?,?,?,?,?)').run(
          request.id,
          podId,
          s.taskId,
          JSON.stringify(request),
          JSON.stringify(actor),
          JSON.stringify(s),
          new Date().toISOString(),
        );
        for (const [ordinal, t] of s.targets.entries())
          db.prepare('INSERT INTO retained_cleanup_targets VALUES (?,?,?,?,?)').run(
            request.id,
            ordinal,
            t.kind,
            t.id,
            t.namespace,
          );
        return get(request.id)!;
      },
    ).immediate,
    append(id: string, ordinal: number, kind: 'dispatch' | 'absent') {
      if (db.inTransaction)
        cleanupConflict('Cleanup dispatch/observation must be independently durable.');
      db.prepare('INSERT OR IGNORE INTO retained_cleanup_facts VALUES (?,?,?,?)').run(
        id,
        ordinal,
        kind,
        new Date().toISOString(),
      );
    },
    dispatch(id: string, ordinal: number) {
      if (db.inTransaction) cleanupConflict('Cleanup dispatch must commit before native effects.');
      return (
        db
          .prepare(`INSERT OR IGNORE INTO retained_cleanup_facts
        SELECT ?,?,'dispatch',? WHERE EXISTS(SELECT 1 FROM retained_cleanup_held WHERE id=?)
          AND NOT EXISTS(SELECT 1 FROM retained_cleanup_facts WHERE request_id=? AND ordinal=? AND kind='absent')`)
          .run(id, ordinal, new Date().toISOString(), id, id, ordinal).changes === 1
      );
    },
    assertInFlight(id: string, ordinal: number) {
      if (
        !db
          .prepare(`SELECT 1 FROM retained_cleanup_held h JOIN retained_cleanup_facts f
        ON f.request_id=h.id WHERE h.id=? AND f.ordinal=? AND f.kind='dispatch'
        AND NOT EXISTS(SELECT 1 FROM retained_cleanup_facts a WHERE a.request_id=h.id AND a.ordinal=f.ordinal AND a.kind='absent')`)
          .get(id, ordinal)
      )
        cleanupConflict('Exact removal capability expired or is no longer owned.');
    },
    block(id: string, blocker: RetainedCleanupBlocker) {
      db.prepare('INSERT OR REPLACE INTO retained_cleanup_blockers VALUES (?,?,?)').run(
        id,
        JSON.stringify(blocker),
        new Date().toISOString(),
      );
    },
    finish: db.transaction((row: Decision, guard: () => void) => {
      if (completed(row.id)) return;
      guard();
      if (
        db
          .prepare(`SELECT 1 FROM retained_cleanup_targets t WHERE request_id=? AND NOT EXISTS(
        SELECT 1 FROM retained_cleanup_facts f WHERE f.request_id=t.request_id AND f.ordinal=t.ordinal AND f.kind='absent')`)
          .get(row.id)
      )
        cleanupConflict('Cannot remove the fleet row before all exact targets are absent.');
      const activeTime =
        db.prepare('SELECT * FROM pod_active_time WHERE pod_id=?').get(row.pod_id) ?? null;
      const qualityScore =
        db.prepare('SELECT * FROM pod_quality_scores WHERE pod_id=?').get(row.pod_id) ?? null;
      db.prepare('INSERT INTO retained_cleanup_history_metrics VALUES (?,?)').run(
        row.id,
        JSON.stringify({ activeTime, qualityScore }),
      );
      archive(row.pod_id);
      db.prepare('INSERT INTO retained_cleanup_completions VALUES (?,?)').run(
        row.id,
        new Date().toISOString(),
      );
      if (db.prepare('DELETE FROM pods WHERE id=?').run(row.pod_id).changes !== 1)
        throw new PodNotFoundError(row.pod_id);
    }).immediate,
  };
}
export type RetainedCleanupRepository = ReturnType<typeof createRetainedCleanupRepository>;
