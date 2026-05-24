import crypto from 'node:crypto';
import type { MemoryEntry, MemoryKind, MemoryScope, MemorySourceEvidence } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface MemoryRepository {
  list(scope: MemoryScope, scopeId: string | null, approvedOnly?: boolean): MemoryEntry[];
  listByScope(scope: MemoryScope, approvedOnly?: boolean): MemoryEntry[];
  getOrThrow(id: string): MemoryEntry;
  insert(
    entry: Omit<MemoryEntry, 'version' | 'contentSha256' | 'createdAt' | 'updatedAt'>,
  ): MemoryEntry;
  approve(id: string): void;
  reject(id: string): void;
  update(id: string, content: string): void;
  updateMetadata(
    id: string,
    content: string,
    metadata: Pick<
      MemoryEntry,
      'kind' | 'tags' | 'appliesWhen' | 'avoidWhen' | 'confidence' | 'sourceEvidence' | 'impactSummary'
    >,
  ): void;
  delete(id: string): void;
  search(query: string, scope: MemoryScope, scopeId: string | null): MemoryEntry[];
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToMemoryEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    scope: row.scope as MemoryScope,
    scopeId: (row.scope_id as string) ?? null,
    path: row.path as string,
    content: row.content as string,
    contentSha256: row.content_sha256 as string,
    rationale: (row.rationale as string) ?? null,
    kind: (row.kind as MemoryKind) ?? null,
    tags: parseJson<string[]>(row.tags, []),
    appliesWhen: (row.applies_when as string) ?? null,
    avoidWhen: (row.avoid_when as string) ?? null,
    confidence: (row.confidence as number) ?? null,
    sourceEvidence: parseJson<MemorySourceEvidence[]>(row.source_evidence, []),
    impactSummary: (row.impact_summary as string) ?? null,
    version: row.version as number,
    approved: Boolean(row.approved),
    createdByPodId: (row.created_by_pod_id as string) ?? null,
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

    listByScope(scope: MemoryScope, approvedOnly = false): MemoryEntry[] {
      const approvedClause = approvedOnly ? 'AND approved = 1' : '';
      const rows = db
        .prepare(
          `SELECT * FROM memory_entries
           WHERE scope = @scope ${approvedClause}
           ORDER BY path ASC`,
        )
        .all({ scope }) as Record<string, unknown>[];
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
         (id, scope, scope_id, path, content, content_sha256, rationale,
          kind, tags, applies_when, avoid_when, confidence, source_evidence, impact_summary,
          version, approved, created_by_pod_id, created_at, updated_at)
         VALUES
         (@id, @scope, @scopeId, @path, @content, @contentSha256, @rationale,
          @kind, @tags, @appliesWhen, @avoidWhen, @confidence, @sourceEvidence, @impactSummary,
          1, @approved, @createdByPodId, @now, @now)`,
      ).run({
        id: entry.id,
        scope: entry.scope,
        scopeId: entry.scopeId,
        path: entry.path,
        content: entry.content,
        contentSha256,
        rationale: entry.rationale ?? null,
        kind: entry.kind ?? null,
        tags: JSON.stringify(entry.tags ?? []),
        appliesWhen: entry.appliesWhen ?? null,
        avoidWhen: entry.avoidWhen ?? null,
        confidence: entry.confidence ?? null,
        sourceEvidence: JSON.stringify(entry.sourceEvidence ?? []),
        impactSummary: entry.impactSummary ?? null,
        approved: entry.approved ? 1 : 0,
        createdByPodId: entry.createdByPodId,
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

    updateMetadata(
      id: string,
      content: string,
      metadata: Pick<
        MemoryEntry,
        | 'kind'
        | 'tags'
        | 'appliesWhen'
        | 'avoidWhen'
        | 'confidence'
        | 'sourceEvidence'
        | 'impactSummary'
      >,
    ): void {
      const now = new Date().toISOString();
      const contentSha256 = sha256(content);
      db.prepare(
        `UPDATE memory_entries SET
           content = @content,
           content_sha256 = @contentSha256,
           kind = @kind,
           tags = @tags,
           applies_when = @appliesWhen,
           avoid_when = @avoidWhen,
           confidence = @confidence,
           source_evidence = @sourceEvidence,
           impact_summary = @impactSummary,
           version = version + 1,
           updated_at = @now
         WHERE id = @id`,
      ).run({
        id,
        content,
        contentSha256,
        kind: metadata.kind ?? null,
        tags: JSON.stringify(metadata.tags ?? []),
        appliesWhen: metadata.appliesWhen ?? null,
        avoidWhen: metadata.avoidWhen ?? null,
        confidence: metadata.confidence ?? null,
        sourceEvidence: JSON.stringify(metadata.sourceEvidence ?? []),
        impactSummary: metadata.impactSummary ?? null,
        now,
      });
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
