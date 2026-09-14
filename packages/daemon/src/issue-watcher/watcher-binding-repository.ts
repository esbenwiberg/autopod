import { randomUUID } from 'node:crypto';
import {
  type IssueWatcherBinding,
  issueWatcherBindingSchema,
  writeIssueWatcherBindingSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationError } from '../configuration/configuration-store.js';

interface Row {
  id: string;
  revision: number;
  owner_user_id: string;
  payload: string;
  created_at: string;
  updated_at: string;
}
const project = (row: Row): IssueWatcherBinding => ({
  id: row.id,
  revision: row.revision,
  ownerUserId: row.owner_user_id,
  payload: issueWatcherBindingSchema.parse(JSON.parse(row.payload)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Operator-owned saved launch choices; each picked-up issue receives an immutable launch snapshot. */
export function createWatcherBindingRepository(db: Database.Database) {
  const get = (id: string): IssueWatcherBinding => {
    const row = db.prepare('SELECT * FROM issue_watcher_bindings WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!row) configurationError('Issue watcher binding not found', 'WATCHER_NOT_FOUND', 404);
    return project(row);
  };
  return {
    get,
    list(): IssueWatcherBinding[] {
      return (db.prepare('SELECT * FROM issue_watcher_bindings ORDER BY id').all() as Row[]).map(
        project,
      );
    },
    write(raw: unknown, ownerUserId: string): IssueWatcherBinding {
      const input = writeIssueWatcherBindingSchema.parse(raw);
      if (!ownerUserId.trim()) configurationError('Issue watcher owner is required');
      const id = input.id ?? randomUUID();
      const now = new Date().toISOString();
      return db.transaction(() => {
        if (input.payload.enabled) {
          const others = (
            db.prepare('SELECT * FROM issue_watcher_bindings WHERE id!=?').all(id) as Row[]
          ).map(project);
          if (
            others.some(
              (item) =>
                item.payload.enabled &&
                item.payload.launch.repositoryId === input.payload.launch.repositoryId &&
                item.payload.labelPrefix === input.payload.labelPrefix,
            )
          )
            configurationError(
              'An enabled watcher already owns this repository and label prefix',
              'WATCHER_SCOPE_CONFLICT',
              409,
            );
        }
        const exists = db.prepare('SELECT 1 FROM issue_watcher_bindings WHERE id=?').get(id);
        if (exists) {
          const previous = get(id);
          if (previous.ownerUserId !== ownerUserId || previous.revision !== input.expectedRevision)
            configurationError('Watcher owner or revision changed', 'WATCHER_CHANGED', 409);
          db.prepare(
            'UPDATE issue_watcher_bindings SET payload=?,revision=revision+1,updated_at=? WHERE id=?',
          ).run(JSON.stringify(input.payload), now, id);
        } else {
          if (input.expectedRevision !== undefined)
            configurationError('Watcher no longer exists', 'WATCHER_CHANGED', 409);
          db.prepare(
            'INSERT INTO issue_watcher_bindings(id,revision,owner_user_id,payload,created_at,updated_at) VALUES(?,1,?,?,?,?)',
          ).run(id, ownerUserId, JSON.stringify(input.payload), now, now);
        }
        return get(id);
      })();
    },
  };
}
export type WatcherBindingRepository = ReturnType<typeof createWatcherBindingRepository>;
