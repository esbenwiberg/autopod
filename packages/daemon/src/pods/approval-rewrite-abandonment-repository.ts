import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { AutopodError, type Pod } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { recoveryHash } from '../containers/sandbox-recovery-journal.js';
import { retainedPathIdentity } from './retained-path-identity.js';
import { assertValidationResourceSettled } from './validation-execution-evidence.js';

export function abandonmentError(message: string): never {
  throw new AutopodError(message, 'APPROVAL_REWRITE_ABANDONMENT_BLOCKED', 409);
}
export interface RewriteAbandonmentResource {
  sandboxId: string;
  resourceKey: string;
  recoveryId: string;
  validationEvidence: string | null;
  intentIds: string[];
}
export interface RewriteAbandonmentSnapshot {
  source: string;
  resources: RewriteAbandonmentResource[];
  worktrees: string[];
  pathIdentities: string[];
}
export interface RewriteAbandonmentDecision {
  id: string;
  podId: string;
  generation: number;
  binding: string;
  requestHash: string;
  userId: string;
  reason: string;
  snapshot: RewriteAbandonmentSnapshot;
  createdAt: string;
}
interface Owner {
  podId: string;
  containerId?: string;
  cleanup: boolean;
  paths: string[];
}
const scopes = new WeakMap<Database.Database, AsyncLocalStorage<() => Owner>>();
export function ownsRewriteAbandonment(
  db: Database.Database,
  selection: { podId: string } | { containerId: string },
): boolean {
  const owner = scopes.get(db)?.getStore()?.();
  return (
    !!owner &&
    ('podId' in selection
      ? owner.cleanup && owner.podId === selection.podId
      : owner.containerId === selection.containerId)
  );
}
export function assertNoRewriteAbandonment(db: Database.Database, podId: string): void {
  if (db.prepare('SELECT 1 FROM approval_rewrite_abandonments WHERE pod_id=?').get(podId))
    abandonmentError(
      'Rewrite abandonment owns this task permanently; only its exact deletion request may proceed.',
    );
}

const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
export function assertRewriteAbandonmentPathAvailable(
  db: Database.Database,
  location: string,
): void {
  const rows = db
    .prepare('SELECT pod_id AS podId,snapshot FROM approval_rewrite_abandonments')
    .all() as { podId: string; snapshot: string }[];
  if (!rows.length) return;
  const candidates = [path.resolve(location), retainedPathIdentity(location)];
  const owner = scopes.get(db)?.getStore()?.();
  for (const row of rows) {
    const selected = JSON.parse(row.snapshot) as RewriteAbandonmentSnapshot;
    for (let i = 0; i < selected.worktrees.length; i++) {
      const worktree = selected.worktrees[i]!;
      const physical = retainedPathIdentity(worktree);
      if (physical !== selected.pathIdentities[i])
        abandonmentError('Reserved worktree physical identity changed.');
      if (
        candidates.some((candidate) =>
          [path.resolve(worktree), physical].some((held) => overlaps(candidate, held)),
        )
      ) {
        if (
          owner?.cleanup &&
          owner.podId === row.podId &&
          owner.paths.includes(worktree) &&
          candidates.every(
            (candidate) =>
              candidate === physical ||
              candidate.startsWith(physical + path.sep) ||
              candidate === path.resolve(worktree) ||
              candidate.startsWith(path.resolve(worktree) + path.sep),
          )
        )
          continue;
        abandonmentError(
          'Rewrite abandonment reserves this source path; no competing mutation is authorized.',
        );
      }
    }
  }
}

export function createRewriteAbandonmentRepository(db: Database.Database) {
  const get = (id: string): RewriteAbandonmentDecision | undefined => {
    const row = db
      .prepare(`SELECT id,pod_id AS podId,generation,binding,request_hash AS requestHash,
      user_id AS userId,reason,snapshot,created_at AS createdAt FROM approval_rewrite_abandonments WHERE id=?`)
      .get(id) as (Omit<RewriteAbandonmentDecision, 'snapshot'> & { snapshot: string }) | undefined;
    return row ? { ...row, snapshot: JSON.parse(row.snapshot) } : undefined;
  };
  const events = (id: string) =>
    db
      .prepare(`SELECT kind,resource,recorded_at AS recordedAt
    FROM approval_rewrite_abandonment_events WHERE request_id=? ORDER BY rowid`)
      .all(id) as Array<{
      kind: string;
      resource: string;
      recordedAt: string;
    }>;
  const has = (id: string, kind: string, resource = '') =>
    Boolean(
      db
        .prepare(`SELECT 1 FROM
    approval_rewrite_abandonment_events WHERE request_id=? AND kind=? AND resource=?`)
        .get(id, kind, resource),
    );
  return {
    get,
    events,
    has,
    assertCleanupCompleted(podId: string) {
      if (
        !db
          .prepare(
            'SELECT 1 FROM deletion_cleanup_intents WHERE pod_id=? AND completed_at IS NOT NULL',
          )
          .get(podId)
      )
        abandonmentError('The exact owned pod cleanup has not completed.');
    },
    assertAvailable: (podId: string) => assertNoRewriteAbandonment(db, podId),
    assertHistoricalResourceSettled: (id: string) => assertValidationResourceSettled(db, id),
    forPod(podId: string) {
      const row = db
        .prepare('SELECT id FROM approval_rewrite_abandonments WHERE pod_id=?')
        .get(podId) as { id: string } | undefined;
      return row ? get(row.id) : undefined;
    },
    /** Include immutable source/execution facts, not evolving provider observations or our own receipts. */
    source(pod: Pod): string {
      const rewrites = db
        .prepare('SELECT * FROM approval_source_rewrites WHERE pod_id=? ORDER BY rowid')
        .all(pod.id);
      const rewriteEvents = db
        .prepare(`SELECT e.* FROM approval_source_rewrite_events e JOIN
        approval_source_rewrites r ON r.id=e.rewrite_id WHERE r.pod_id=? ORDER BY e.sequence`)
        .all(pod.id);
      const validation = db
        .prepare(`SELECT d.*,r.result_hash,o.result_hash AS outcome_hash,p.result_hash AS publication_hash
        FROM validation_dispatches d LEFT JOIN validation_dispatch_results r ON r.dispatch_id=d.id
        LEFT JOIN validation_dispatch_outcomes o ON o.dispatch_id=d.id
        LEFT JOIN validation_logical_publications p ON p.dispatch_id=d.id WHERE d.pod_id=? ORDER BY d.rowid`)
        .all(pod.id);
      // Mutable display/accounting and reference maintenance are not source authority.
      const source = {
        id: pod.id,
        generation: pod.lifecycleGeneration,
        status: pod.status,
        userId: pod.userId,
        containerId: pod.containerId,
        target: pod.executionTarget,
        worktreePath: pod.worktreePath,
        recoveryWorktreePath: pod.recoveryWorktreePath,
        task: pod.task,
        runtime: pod.runtime,
        model: pod.model,
        branch: pod.branch,
        baseBranch: pod.baseBranch,
        startBranch: pod.startBranch,
        prUrl: pod.prUrl,
        profileName: pod.profileName,
        profileSnapshot: pod.profileSnapshot,
        launchConfigDigest: pod.launchConfigDigest,
        options: pod.options,
        contract: pod.contract,
        provider: pod.providerIdSnapshot,
        account: pod.providerAccountIdSnapshot,
        result: pod.lastValidationResult,
        attempts: pod.validationAttempts,
        maxAttempts: pod.maxValidationAttempts,
        skipValidation: pod.skipValidation,
        waiver: pod.validationWaiver,
        overrides: pod.validationOverrides,
        pendingEscalation: pod.pendingEscalation,
        sidecars: pod.sidecarContainerIds,
        tests: pod.testRunBranches,
        tokenBudget: pod.tokenBudget,
        compromised: pod.worktreeCompromised,
      };
      return recoveryHash([source, rewrites, rewriteEvents, validation]);
    },
    validationResources(podId: string, scope: string, worktrees: string[]) {
      const rows = db
        .prepare('SELECT binding FROM validation_dispatches WHERE pod_id=? ORDER BY rowid')
        .all(podId) as { binding: string }[];
      return rows.map((row) => {
        const binding = JSON.parse(row.binding);
        if (
          binding.podId !== podId ||
          binding.executionTarget !== 'sandbox' ||
          binding.resourceScope !== scope ||
          !worktrees.includes(binding.worktreePath)
        )
          abandonmentError(
            'Historical validation belongs to a different source or provider namespace.',
          );
        return String(binding.containerId);
      });
    },
    assertSingleRewrite(podId: string, rewriteId: string) {
      const rows = db
        .prepare('SELECT id FROM approval_source_rewrites WHERE pod_id=?')
        .all(podId) as { id: string }[];
      if (rows.length !== 1 || rows[0]?.id !== rewriteId)
        abandonmentError(
          'Only a single unrepaired approval rewrite is supported by this destructive protocol.',
        );
    },
    assertUnshared(podId: string, sandboxId: string, worktrees: string[]) {
      if (
        db.prepare('SELECT 1 FROM pods WHERE id<>? AND container_id=?').get(podId, sandboxId) ||
        db
          .prepare(
            `SELECT 1 FROM validation_dispatches WHERE pod_id<>? AND json_extract(binding,'$.containerId')=?`,
          )
          .get(podId, sandboxId) ||
        db
          .prepare(
            `SELECT 1 FROM approval_source_rewrites WHERE pod_id<>? AND json_extract(binding,'$.containerId')=?`,
          )
          .get(podId, sandboxId) ||
        db
          .prepare('SELECT 1 FROM sandbox_wakeup_intents WHERE pod_id<>? AND sandbox_id=?')
          .get(podId, sandboxId) ||
        db
          .prepare('SELECT 1 FROM sandbox_recovery_requests WHERE pod_id<>? AND sandbox_id=?')
          .get(podId, sandboxId)
      )
        abandonmentError('A foreign owner claims a selected sandbox.');
      const foreign = db
        .prepare(`SELECT worktree_path AS location FROM pods WHERE id<>? AND worktree_path IS NOT NULL
        UNION SELECT recovery_worktree_path FROM pods WHERE id<>? AND recovery_worktree_path IS NOT NULL
        UNION SELECT json_extract(binding,'$.worktreePath') FROM approval_source_rewrites WHERE pod_id<>?
        UNION SELECT json_extract(e.evidence,'$.worktreePath') FROM approval_source_rewrite_events e JOIN approval_source_rewrites r ON r.id=e.rewrite_id WHERE r.pod_id<>? AND e.kind='prepared'
        UNION SELECT json_extract(binding,'$.worktreePath') FROM validation_dispatches WHERE pod_id<>?
        UNION SELECT json_extract(binding,'$.worktreePath') FROM source_adoptions WHERE pod_id<>?
        UNION SELECT r.worktree_path FROM source_publication_resources r JOIN source_publication_intents i ON i.id=r.intent_id WHERE i.pod_id<>?`)
        .all(podId, podId, podId, podId, podId, podId, podId) as { location: string | null }[];
      for (const worktree of worktrees)
        for (const row of foreign) {
          if (
            row.location &&
            [path.resolve(worktree), retainedPathIdentity(worktree)].some((held) =>
              [path.resolve(row.location!), retainedPathIdentity(row.location!)].some((other) =>
                overlaps(held, other),
              ),
            )
          )
            abandonmentError('A foreign owner claims an overlapping selected worktree.');
        }
    },
    admit(decision: Omit<RewriteAbandonmentDecision, 'createdAt'>): RewriteAbandonmentDecision {
      return db.transaction(() => {
        if (
          db
            .prepare('SELECT 1 FROM approval_rewrite_abandonments WHERE id=? OR pod_id=?')
            .get(decision.id, decision.podId)
        )
          abandonmentError('Another abandonment decision already owns this request or pod.');
        db.prepare(`INSERT INTO approval_rewrite_abandonments
        (id,pod_id,generation,binding,request_hash,user_id,reason,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
          decision.id,
          decision.podId,
          decision.generation,
          decision.binding,
          decision.requestHash,
          decision.userId,
          decision.reason,
          JSON.stringify(decision.snapshot),
          new Date().toISOString(),
        );
        return get(decision.id)!;
      })();
    },
    append(
      id: string,
      kind: 'dispatch' | 'deleted' | 'worktree-cleaned' | 'complete',
      resource = '',
    ) {
      db.prepare(`INSERT INTO approval_rewrite_abandonment_events(request_id,kind,resource,recorded_at)
        VALUES(?,?,?,?)`).run(id, kind, resource, new Date().toISOString());
    },
    async withOwner<T>(
      id: string,
      containerId: string | undefined,
      assertCurrent: () => void,
      operation: () => Promise<T>,
    ): Promise<T> {
      let active = true;
      const authorize = () => {
        if (!active) abandonmentError('Rewrite abandonment capability expired.');
        assertCurrent();
        const row = get(id) ?? abandonmentError('Durable rewrite abandonment unavailable.');
        if (containerId && !row.snapshot.resources.some((r) => r.sandboxId === containerId))
          abandonmentError('The selected resource is not owned by this abandonment.');
        if (!containerId && row.snapshot.resources.some((r) => !has(id, 'deleted', r.sandboxId)))
          abandonmentError('Every selected sandbox must be confirmed deleted before pod cleanup.');
        return {
          podId: row.podId,
          containerId,
          cleanup: !containerId,
          paths: row.snapshot.worktrees,
        };
      };
      authorize();
      let scope = scopes.get(db);
      if (!scope) {
        scope = new AsyncLocalStorage<() => Owner>();
        scopes.set(db, scope);
      }
      return scope.run(authorize, async () => {
        try {
          return await operation();
        } finally {
          active = false;
        }
      });
    },
  };
}
export type RewriteAbandonmentRepository = ReturnType<typeof createRewriteAbandonmentRepository>;
