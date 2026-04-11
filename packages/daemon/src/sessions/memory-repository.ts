import crypto from 'node:crypto';
import type { MemoryEntry, MemoryScope } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface MemoryRepository {
  list(scope: MemoryScope, scopeId: string | null, approvedOnly?: boolean): MemoryEntry[];
  getOrThrow(id: string): MemoryEntry;
  insert(
    entry: Omit<MemoryEntry, 'version' | 'contentSha256' | 'createdAt' | 'updatedAt'>,
  ): MemoryEntry;
  approve(id: string): void;
  reject(id: string): void;
  update(id: string, content: string): void;
  delete(id: string): void;
  search(query: string, scope: MemoryScope, scopeId: string | null): MemoryEntry[];
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function rowToMemoryEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    scope: row.scope as MemoryScope,
    scopeId: (row.scope_id as string) ?? null,
    path: row.path as string,
    content: row.content as string,
    contentSha256: row.content_sha256 as string,
    version: row.version as number,
    approved: Boolean(row.approved),
    createdBySessionId: (row.created_by_session_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createMemoryRepository(db: Database.Database): MemoryRepository {
  return {
    list(scope: MemoryScope, scopeId: string | null, approvedOnly = false): MemoryEntry[] {
      const params: Record<string, unknown> = { scope, scopeId };
      const approvedClause = approvedOnly ? 'AND approved = 1' : '';
      const rows = db
        .prepare(
          `SELECT * FROM memory_entries
           WHERE scope = @scope AND scope_id IS @scopeId ${approvedClause}
           ORDER BY path ASC`,
        )
        .all(params) as Record<string, unknown>[];
      return rows.map(rowToMemoryEntry);
    },

    getOrThrow(id: string): MemoryEntry {
      const row = db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new Error(`Memory entry not found: ${id}`);
      return rowToMemoryEntry(row);
    },

    insert(
      entry: Omit<MemoryEntry, 'version' | 'contentSha256' | 'createdAt' | 'updatedAt'>,
    ): MemoryEntry {
      const now = new Date().toISOString();
      const contentSha256 = sha256(entry.content);
      db.prepare(
        `INSERT INTO memory_entries
         (id, scope, scope_id, path, content, content_sha256, version, approved, created_by_session_id, created_at, updated_at)
         VALUES (@id, @scope, @scopeId, @path, @content, @contentSha256, 1, @approved, @createdBySessionId, @now, @now)`,
      ).run({
        id: entry.id,
        scope: entry.scope,
        scopeId: entry.scopeId,
        path: entry.path,
        content: entry.content,
        contentSha256,
        approved: entry.approved ? 1 : 0,
        createdBySessionId: entry.createdBySessionId,
        now,
      });
      return this.getOrThrow(entry.id);
    },

    approve(id: string): void {
      const now = new Date().toISOString();
      db.prepare('UPDATE memory_entries SET approved = 1, updated_at = @now WHERE id = @id').run({
        id,
        now,
      });
    },

    reject(id: string): void {
      db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
    },

    update(id: string, content: string): void {
      const now = new Date().toISOString();
      const contentSha256 = sha256(content);
      db.prepare(
        'UPDATE memory_entries SET content = @content, content_sha256 = @contentSha256, version = version + 1, updated_at = @now WHERE id = @id',
      ).run({ id, content, contentSha256, now });
    },

    delete(id: string): void {
      db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
    },

    search(query: string, scope: MemoryScope, scopeId: string | null): MemoryEntry[] {
      const like = `%${query}%`;
      const params: Record<string, unknown> = { scope, scopeId, like };
      const rows = db
        .prepare(
          `SELECT * FROM memory_entries
           WHERE scope = @scope AND scope_id IS @scopeId
             AND (path LIKE @like OR content LIKE @like)
           ORDER BY path ASC`,
        )
        .all(params) as Record<string, unknown>[];
      return rows.map(rowToMemoryEntry);
    },
  };
}
