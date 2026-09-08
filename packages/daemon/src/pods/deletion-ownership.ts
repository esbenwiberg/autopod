import { randomUUID } from 'node:crypto';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';

export function deletionOwnershipError(): AutopodError {
  return new AutopodError(
    'Pod deletion cleanup ownership is unresolved. Retain its resources and reconcile the saved cleanup attempt before retrying or starting work.',
    'POD_DELETE_CLEANUP_UNVERIFIED',
    409,
  );
}
export interface DeletionClaim {
  assertCurrent(): void;
  hasCompleted(name: string): boolean;
  completeStep(name: string): void;
  settle(): void;
  finish(remove: () => void): void;
}
export interface DeletionOwnership {
  acquire(podId: string, configuration: string): DeletionClaim;
  assertTaskAvailable(podId: string): void;
}
/** Durable resource intent with non-expiring exclusive attempts and immutable step receipts. */
export function createDeletionOwnership(db: Database.Database): DeletionOwnership {
  const resourceIdentity = (podId: string, configuration: string) => {
    const pod = db
      .prepare(`SELECT id, lifecycle_generation, status, container_id, execution_target,
      worktree_path, runtime, profile_name, sidecar_container_ids, test_run_branches
      FROM pods WHERE id=?`)
      .get(podId);
    if (!pod) throw deletionOwnershipError();
    const identity = JSON.stringify({ pod, configuration });
    if (Buffer.byteLength(identity, 'utf8') > 64 * 1024) throw deletionOwnershipError();
    return identity;
  };
  return {
    assertTaskAvailable(podId) {
      if (
        db
          .prepare(`SELECT 1 FROM deletion_cleanup_intents d JOIN task_executions e
        ON e.task_id=d.task_id WHERE e.pod_id=? AND d.completed_at IS NULL`)
          .get(podId)
      )
        throw deletionOwnershipError();
    },
    acquire: db.transaction((podId: string, configuration: string): DeletionClaim => {
      const identity = resourceIdentity(podId, configuration);
      const task = db.prepare('SELECT task_id FROM task_executions WHERE pod_id=?').get(podId) as
        | { task_id: string }
        | undefined;
      if (!task) throw deletionOwnershipError();
      if (
        db
          .prepare(`SELECT 1 FROM task_agent_runs r JOIN task_executions e ON e.pod_id=r.pod_id
        WHERE e.task_id=? AND r.ended_at IS NULL`)
          .get(task.task_id)
      )
        throw deletionOwnershipError();
      const existing = db
        .prepare('SELECT id, identity, completed_at FROM deletion_cleanup_intents WHERE pod_id=?')
        .get(podId) as { id: string; identity: string; completed_at: string | null } | undefined;
      if (existing && (existing.identity !== identity || existing.completed_at !== null))
        throw deletionOwnershipError();
      const id = existing?.id ?? randomUUID();
      if (
        db
          .prepare(
            'SELECT 1 FROM deletion_cleanup_attempts WHERE intent_id=? AND settled_at IS NULL',
          )
          .get(id)
      )
        throw deletionOwnershipError();
      if (!existing)
        db.prepare(
          'INSERT INTO deletion_cleanup_intents(id,pod_id,task_id,identity,created_at) VALUES(?,?,?,?,?)',
        ).run(id, podId, task.task_id, identity, new Date().toISOString());
      const attempt = randomUUID();
      db.prepare(
        'INSERT INTO deletion_cleanup_attempts(id,intent_id,started_at) VALUES(?,?,?)',
      ).run(attempt, id, new Date().toISOString());
      const assertCurrent = () => {
        if (
          resourceIdentity(podId, configuration) !== identity ||
          !db
            .prepare(
              'SELECT 1 FROM deletion_cleanup_attempts WHERE id=? AND intent_id=? AND settled_at IS NULL',
            )
            .get(attempt, id)
        )
          throw deletionOwnershipError();
      };
      return {
        assertCurrent,
        hasCompleted(name) {
          return !!db
            .prepare('SELECT 1 FROM deletion_cleanup_steps WHERE intent_id=? AND name=?')
            .get(id, name);
        },
        completeStep: db.transaction((name: string) => {
          assertCurrent();
          db.prepare(
            'INSERT INTO deletion_cleanup_steps(intent_id,name,attempt_id,completed_at) VALUES(?,?,?,?)',
          ).run(id, name, attempt, new Date().toISOString());
        }),
        settle() {
          db.prepare(
            'UPDATE deletion_cleanup_attempts SET settled_at=? WHERE id=? AND settled_at IS NULL',
          ).run(new Date().toISOString(), attempt);
        },
        finish: db.transaction((remove: () => void) => {
          if (
            resourceIdentity(podId, configuration) !== identity ||
            db
              .prepare(
                'SELECT 1 FROM deletion_cleanup_attempts WHERE intent_id=? AND settled_at IS NULL',
              )
              .get(id)
          )
            throw deletionOwnershipError();
          db.prepare(
            'UPDATE deletion_cleanup_intents SET completed_at=? WHERE id=? AND completed_at IS NULL',
          ).run(new Date().toISOString(), id);
          remove();
        }),
      };
    }),
  };
}
