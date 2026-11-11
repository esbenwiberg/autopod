import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { AutopodError, type Pod, type RetainedFinalizationReceipt } from '@autopod/shared';
import type Database from 'better-sqlite3';
import {
  assertArtifactChecksAvailable,
  assertArtifactChecksPathAvailable,
} from './artifact-checks-recovery-repository.js';
import {
  assertRecoveryForkPathAvailable,
  assertRecoveryForkResourceAvailable,
} from './recovery-fork-repository.js';
import { retainedPathIdentity } from './retained-path-identity.js';
import { assertStalledRecoveryPathAvailable } from './stalled-worker-recovery-repository.js';

export const finalizationHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function finalizationError(message: string): never {
  throw new AutopodError(message, 'RETAINED_FINALIZATION_BLOCKED', 409);
}
export interface FinalizationBinding {
  fingerprint: string;
  generation: number;
  containerId: string | null;
  target: Pod['executionTarget'];
  worktreePath: string | null;
  resources: string[];
  resourceKey?: string;
  taskId: string;
  owners: Array<{ kind: 'continuation' | 'approval-rewrite'; id: string }>;
  sourceLocations: string[];
}
export interface FinalizationRecord {
  binding: FinalizationBinding;
  receipt: RetainedFinalizationReceipt;
  requestHash: string;
  stopDispatched: boolean;
  evidence: unknown;
}
const scopes = new WeakMap<
  Database.Database,
  AsyncLocalStorage<{ podId: string; stop?: string; assertCurrent?: () => void }>
>();
function scope(db: Database.Database) {
  let value = scopes.get(db);
  if (!value) {
    value = new AsyncLocalStorage();
    scopes.set(db, value);
  }
  return value;
}
/** Only a synchronous terminal transaction can bypass the pod mutation fence. */
export function ownsRetainedFinalization(db: Database.Database, podId: string): boolean {
  const owner = scope(db).getStore();
  return db.inTransaction && owner?.podId === podId && !owner.stop;
}
/** Narrow stop capability; never authorizes kill/start/exec or unknown-execution settlement. */
export function ownsRetainedFinalizationStop(
  db: Database.Database,
  containerId: string,
  target: Pod['executionTarget'],
): boolean {
  const owner = scope(db).getStore();
  if (owner?.stop !== containerId) return false;
  owner.assertCurrent?.();
  const record = createRetainedFinalizationRepository(db).get(owner.podId);
  return Boolean(
    record?.stopDispatched &&
      record.receipt.state === 'pending' &&
      record.binding.containerId === containerId &&
      record.binding.target === target,
  );
}
export function assertFinalizationResourceAvailable(db: Database.Database, id: string) {
  assertRecoveryForkResourceAvailable(db, id);
  if (db.prepare('SELECT 1 FROM retained_finalization_resources WHERE container_id=?').get(id))
    finalizationError(
      'Finalization retains this exact resource; no mutation or release is authorized.',
    );
}
export function finalizationSourceLocations(locations: string[]): string[] {
  const held = new Set(locations.map((location) => path.resolve(location)));
  for (const location of locations) {
    try {
      held.add(realpathSync(location));
    } catch {
      /* Keep the recorded missing location. */
    }
    try {
      const dotgit = path.join(location, '.git');
      const gitdir = statSync(dotgit).isDirectory()
        ? dotgit
        : path.resolve(
            location,
            readFileSync(dotgit, 'utf8')
              .trim()
              .replace(/^gitdir:\s*/, ''),
          );
      held.add(path.resolve(gitdir));
      held.add(realpathSync(gitdir));
      try {
        held.add(path.resolve(gitdir, readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()));
      } catch {
        /* Ordinary checkout, no separate common directory. */
      }
    } catch {
      /* Missing source remains held by its durable location, never inferred disposable. */
    }
  }
  return [...held].sort();
}
export function assertFinalizationPathAvailable(db: Database.Database, location: string): void {
  assertArtifactChecksPathAvailable(db, location);
  assertRecoveryForkPathAvailable(db, location);
  assertStalledRecoveryPathAvailable(db, location);
  const identities = (value: string) => [path.resolve(value), retainedPathIdentity(value)];
  const retained = db
    .prepare(
      `SELECT value AS location FROM retained_finalizations, json_each(binding,'$.sourceLocations')`,
    )
    .all() as { location: string }[];
  if (!retained.length) return;
  const candidates = identities(location);
  for (const row of retained)
    for (const held of identities(row.location))
      for (const candidate of candidates)
        if (
          held === candidate ||
          held.startsWith(candidate.endsWith(path.sep) ? candidate : `${candidate}${path.sep}`) ||
          candidate.startsWith(held.endsWith(path.sep) ? held : `${held}${path.sep}`)
        )
          finalizationError(
            'Finalization retains this source location; no worktree mutation or orphan cleanup is authorized.',
          );
}
export function createRetainedFinalizationRepository(db: Database.Database) {
  const get = (podId: string): FinalizationRecord | null => {
    const row = db.prepare('SELECT * FROM retained_finalizations WHERE pod_id=?').get(podId) as
      | {
          binding: string;
          receipt: string;
          request_hash: string;
          stop_dispatched: number;
          delivery_evidence: string | null;
        }
      | undefined;
    return row
      ? {
          binding: JSON.parse(row.binding),
          receipt: JSON.parse(row.receipt),
          requestHash: row.request_hash,
          stopDispatched: Boolean(row.stop_dispatched),
          evidence: row.delivery_evidence ? JSON.parse(row.delivery_evidence) : null,
        }
      : null;
  };
  const assertAvailable = (podId: string) => {
    if (ownsRetainedFinalization(db, podId)) return;
    const held = db
      .prepare(`SELECT 1 FROM retained_finalizations f WHERE f.pod_id=?
      OR json_extract(f.binding,'$.taskId')=(SELECT task_id FROM task_executions WHERE pod_id=?)
      OR EXISTS(SELECT 1 FROM retained_finalization_resources r JOIN pods p ON p.container_id=r.container_id WHERE r.pod_id=f.pod_id AND p.id=?)
      OR EXISTS(SELECT 1 FROM json_each(f.binding,'$.sourceLocations') WHERE value=(SELECT worktree_path FROM pods WHERE id=?))`)
      .get(podId, podId, podId, podId);
    if (held)
      finalizationError(
        'Retained finalization owns this task and its resources permanently; competing controls are blocked.',
      );
  };
  return {
    get,
    /** Unbounded history: latest-owner projections are authority, not the complete retention set. */
    historicalClaims(podId: string) {
      const checkpoints = db
        .prepare(
          'SELECT id,container_id,worktree_path,binding,original_evidence FROM retained_checkpoint_recoveries WHERE pod_id=? ORDER BY rowid',
        )
        .all(podId) as {
        id: string;
        container_id: string;
        worktree_path: string;
        binding: string;
        original_evidence: string;
      }[];
      const rewrites = db
        .prepare(`SELECT id,binding FROM approval_source_rewrites r WHERE pod_id=?
        AND NOT EXISTS(SELECT 1 FROM approval_source_rewrite_events e WHERE e.rewrite_id=r.id AND e.kind='aborted') ORDER BY rowid`)
        .all(podId) as { id: string; binding: string }[];
      const resources = new Set<string>();
      const locations = new Set<string>();
      const collect = (json: string) => {
        for (const row of db
          .prepare("SELECT key,value FROM json_tree(?) WHERE type='text'")
          .all(json) as { key: string; value: string }[]) {
          if (row.key === 'containerId' && row.value) resources.add(row.value);
          if (
            [
              'path',
              'worktree',
              'worktreePath',
              'artifactsPath',
              'root',
              'bare',
              'snapshot',
              'bundle',
            ].includes(row.key) &&
            path.isAbsolute(row.value)
          )
            locations.add(row.value);
        }
      };
      for (const row of checkpoints) {
        resources.add(row.container_id);
        locations.add(row.worktree_path);
        collect(row.binding);
        collect(row.original_evidence);
        for (const event of db
          .prepare(
            'SELECT evidence FROM retained_checkpoint_recovery_events WHERE recovery_id=? ORDER BY sequence',
          )
          .all(row.id) as { evidence: string }[])
          collect(event.evidence);
      }
      for (const row of rewrites) {
        collect(row.binding);
        for (const event of db
          .prepare(
            'SELECT evidence FROM approval_source_rewrite_events WHERE rewrite_id=? ORDER BY sequence',
          )
          .all(row.id) as { evidence: string }[])
          collect(event.evidence);
      }
      for (const row of db
        .prepare('SELECT binding FROM validation_dispatches WHERE pod_id=? ORDER BY rowid')
        .all(podId) as { binding: string }[])
        collect(row.binding);
      return { resources: [...resources].sort(), sourceLocations: [...locations].sort() };
    },
    assertAvailable,
    retains: (id: string) =>
      Boolean(
        db.prepare('SELECT 1 FROM retained_finalization_resources WHERE container_id=?').get(id),
      ),
    resourceIds: () =>
      (
        db
          .prepare('SELECT DISTINCT container_id AS id FROM retained_finalization_resources')
          .all() as { id: string }[]
      ).map((r) => r.id),
    admit(
      binding: FinalizationBinding,
      receipt: RetainedFinalizationReceipt,
      requestHash: string,
      evidence: unknown,
    ) {
      db.transaction(() => {
        assertArtifactChecksAvailable(db, receipt.podId);
        assertAvailable(receipt.podId);
        if (
          db
            .prepare('SELECT 1 FROM retained_finalizations WHERE request_key=?')
            .get(receipt.request.requestKey)
        )
          finalizationError('Request key already belongs to another finalization.');
        db.prepare(
          'INSERT INTO retained_finalizations(pod_id,request_key,request_hash,binding,receipt,delivery_evidence) VALUES(?,?,?,?,?,?)',
        ).run(
          receipt.podId,
          receipt.request.requestKey,
          requestHash,
          JSON.stringify(binding),
          JSON.stringify(receipt),
          JSON.stringify(evidence),
        );
        for (const id of binding.resources)
          db.prepare(
            'INSERT INTO retained_finalization_resources(pod_id,container_id) VALUES(?,?)',
          ).run(receipt.podId, id);
      }).immediate();
    },
    dispatchStop<T>(podId: string, stop: () => T, assertCurrent: () => void): T {
      assertCurrent();
      const row = get(podId) ?? finalizationError('Finalization intent missing.');
      if (!row.binding.containerId || row.stopDispatched || row.receipt.state !== 'pending')
        finalizationError('Stop already dispatched or unavailable; observation only is permitted.');
      const changed = db
        .prepare(
          'UPDATE retained_finalizations SET stop_dispatched=1 WHERE pod_id=? AND stop_dispatched=0',
        )
        .run(podId);
      if (changed.changes !== 1) finalizationError('Stop dispatch already owned.');
      return scope(db).run({ podId, stop: row.binding.containerId, assertCurrent }, stop);
    },
    terminal<T>(podId: string, work: () => T): T {
      if (!db.inTransaction)
        finalizationError('Terminal state and receipt require one managed transaction.');
      return scope(db).run({ podId }, work);
    },
    finish(podId: string, evidence: unknown) {
      if (!ownsRetainedFinalization(db, podId)) finalizationError('Terminal transaction required.');
      const row = get(podId) ?? finalizationError('Finalization intent missing.');
      const receipt: RetainedFinalizationReceipt = {
        ...row.receipt,
        state: 'finalized',
        finalizedAt: new Date().toISOString(),
        message:
          row.receipt.request.mode === 'stop-retain'
            ? 'Cancelled; all source, resources and evidence retained. No success claimed.'
            : 'Provider-proven external delivery recorded; old validation results unchanged and all resources retained.',
      };
      db.prepare(
        'UPDATE retained_finalizations SET receipt=?,delivery_evidence=? WHERE pod_id=?',
      ).run(JSON.stringify(receipt), JSON.stringify(evidence), podId);
      return receipt;
    },
  };
}
export type RetainedFinalizationRepository = ReturnType<
  typeof createRetainedFinalizationRepository
>;
