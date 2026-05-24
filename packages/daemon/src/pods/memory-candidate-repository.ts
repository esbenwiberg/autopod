import type {
  MemoryCandidate,
  MemoryCandidateAction,
  MemoryCandidateStatus,
  MemoryKind,
  MemorySourceEvidence,
} from '@autopod/shared';
import { generateId } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { MemoryRepository } from './memory-repository.js';
import { parseJsonColumn } from './memory-repository.js';

export interface MemoryCandidateRepository {
  insert(
    candidate: Omit<MemoryCandidate, 'status' | 'createdAt' | 'updatedAt'>,
  ): MemoryCandidate;
  get(id: string): MemoryCandidate | null;
  listPending(scopeId: string): MemoryCandidate[];
  list(scopeId: string, status?: MemoryCandidateStatus): MemoryCandidate[];
  /** Approve a pending candidate. Creates or updates a MemoryEntry. */
  approve(id: string, memoryRepo: MemoryRepository): MemoryCandidate;
  /** Reject a pending candidate. Retains row for audit. */
  reject(id: string): MemoryCandidate;
}

function rowToCandidate(row: Record<string, unknown>): MemoryCandidate {
  return {
    id: row.id as string,
    action: row.action as MemoryCandidateAction,
    targetMemoryId: (row.target_memory_id as string) ?? null,
    scope: (row.scope as 'profile') ?? 'profile',
    scopeId: row.scope_id as string,
    path: row.path as string,
    content: row.content as string,
    rationale: row.rationale as string,
    kind: row.kind as MemoryKind,
    tags: parseJsonColumn<string[]>(row.tags, []),
    appliesWhen: (row.applies_when as string) ?? null,
    avoidWhen: (row.avoid_when as string) ?? null,
    confidence: row.confidence as number,
    sourceEvidence: parseJsonColumn<MemorySourceEvidence[]>(row.source_evidence, []),
    impactSummary: row.impact_summary as string,
    status: row.status as MemoryCandidateStatus,
    createdByPodId: row.created_by_pod_id as string,
    fallbackReason: (row.fallback_reason as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function getOrThrow(db: Database.Database, id: string): MemoryCandidate {
  const row = db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Memory candidate not found: ${id}`);
  return rowToCandidate(row);
}

export function createMemoryCandidateRepository(
  db: Database.Database,
): MemoryCandidateRepository {
  return {
    insert(candidate: Omit<MemoryCandidate, 'status' | 'createdAt' | 'updatedAt'>): MemoryCandidate {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO memory_candidates
         (id, action, target_memory_id, scope, scope_id, path, content, rationale,
          kind, tags, applies_when, avoid_when, confidence, source_evidence, impact_summary,
          status, created_by_pod_id, fallback_reason, created_at, updated_at)
         VALUES
         (@id, @action, @targetMemoryId, @scope, @scopeId, @path, @content, @rationale,
          @kind, @tags, @appliesWhen, @avoidWhen, @confidence, @sourceEvidence, @impactSummary,
          'pending', @createdByPodId, @fallbackReason, @now, @now)`,
      ).run({
        id: candidate.id,
        action: candidate.action,
        targetMemoryId: candidate.targetMemoryId ?? null,
        scope: candidate.scope,
        scopeId: candidate.scopeId,
        path: candidate.path,
        content: candidate.content,
        rationale: candidate.rationale,
        kind: candidate.kind,
        tags: JSON.stringify(candidate.tags ?? []),
        appliesWhen: candidate.appliesWhen ?? null,
        avoidWhen: candidate.avoidWhen ?? null,
        confidence: candidate.confidence,
        sourceEvidence: JSON.stringify(candidate.sourceEvidence ?? []),
        impactSummary: candidate.impactSummary,
        createdByPodId: candidate.createdByPodId,
        fallbackReason: candidate.fallbackReason ?? null,
        now,
      });
      return { ...candidate, status: 'pending', createdAt: now, updatedAt: now };
    },

    get(id: string): MemoryCandidate | null {
      const row = db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? rowToCandidate(row) : null;
    },

    listPending(scopeId: string): MemoryCandidate[] {
      const rows = db
        .prepare(
          `SELECT * FROM memory_candidates
           WHERE scope_id = @scopeId AND status = 'pending'
           ORDER BY created_at ASC`,
        )
        .all({ scopeId }) as Record<string, unknown>[];
      return rows.map(rowToCandidate);
    },

    list(scopeId: string, status?: MemoryCandidateStatus): MemoryCandidate[] {
      const params: Record<string, unknown> = { scopeId };
      const statusClause = status ? 'AND status = @status' : '';
      if (status) params.status = status;
      const rows = db
        .prepare(
          `SELECT * FROM memory_candidates
           WHERE scope_id = @scopeId ${statusClause}
           ORDER BY created_at ASC`,
        )
        .all(params) as Record<string, unknown>[];
      return rows.map(rowToCandidate);
    },

    approve(id: string, memoryRepo: MemoryRepository): MemoryCandidate {
      const candidate = getOrThrow(db, id);
      if (candidate.status !== 'pending') {
        throw new Error(`Candidate ${id} is not pending (status: ${candidate.status})`);
      }

      const now = new Date().toISOString();

      // Atomic: memory write + candidate status update share one transaction so a
      // crash between them can't leave an approved memory with a still-pending
      // candidate (or vice versa).
      const tx = db.transaction(() => {
        if (candidate.action === 'update') {
          // target_memory_id has ON DELETE SET NULL, so a deleted target shows up
          // here as a null id. Either case (null id, or id present but row gone)
          // must throw — an operator approved an UPDATE, not a silent CREATE.
          if (!candidate.targetMemoryId) {
            throw new Error(
              `Candidate ${id} is an update but its target memory no longer exists`,
            );
          }
          memoryRepo.getOrThrow(candidate.targetMemoryId);
          memoryRepo.updateMetadata(candidate.targetMemoryId, candidate.content, {
            kind: candidate.kind,
            tags: candidate.tags,
            appliesWhen: candidate.appliesWhen,
            avoidWhen: candidate.avoidWhen,
            confidence: candidate.confidence,
            sourceEvidence: candidate.sourceEvidence,
            impactSummary: candidate.impactSummary,
          });
        } else {
          // createdByPodId is null because the memory is created by the human reviewer;
          // the candidate itself retains the originating pod ID for provenance.
          memoryRepo.insert({
            id: generateId(8),
            scope: 'profile',
            scopeId: candidate.scopeId,
            path: candidate.path,
            content: candidate.content,
            rationale: candidate.rationale,
            kind: candidate.kind,
            tags: candidate.tags,
            appliesWhen: candidate.appliesWhen,
            avoidWhen: candidate.avoidWhen,
            confidence: candidate.confidence,
            sourceEvidence: candidate.sourceEvidence,
            impactSummary: candidate.impactSummary,
            approved: true,
            createdByPodId: null,
          });
        }

        db.prepare(
          'UPDATE memory_candidates SET status = @status, updated_at = @now WHERE id = @id',
        ).run({ id, status: 'approved', now });
      });
      tx();

      return { ...candidate, status: 'approved', updatedAt: now };
    },

    reject(id: string): MemoryCandidate {
      const candidate = getOrThrow(db, id);
      if (candidate.status !== 'pending') {
        throw new Error(`Candidate ${id} is not pending (status: ${candidate.status})`);
      }
      const now = new Date().toISOString();
      db.prepare(
        'UPDATE memory_candidates SET status = @status, updated_at = @now WHERE id = @id',
      ).run({ id, status: 'rejected', now });
      return { ...candidate, status: 'rejected', updatedAt: now };
    },
  };
}
