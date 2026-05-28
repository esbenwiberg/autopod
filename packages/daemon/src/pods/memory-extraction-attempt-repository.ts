import type { MemoryExtractionAttempt, MemoryExtractionAttemptStatus } from '@autopod/shared';
import { generateId } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { parseJsonColumn } from './memory-repository.js';

export interface MemoryExtractionAttemptRepository {
  record(
    attempt: Omit<MemoryExtractionAttempt, 'id' | 'createdAt' | 'updatedAt'>,
  ): MemoryExtractionAttempt;
  getByPod(podId: string): MemoryExtractionAttempt | null;
  listByProfile(profileName: string, limit?: number): MemoryExtractionAttempt[];
}

function rowToAttempt(row: Record<string, unknown>): MemoryExtractionAttempt {
  return {
    id: row.id as string,
    podId: row.pod_id as string,
    profileName: row.profile_name as string,
    status: row.status as MemoryExtractionAttemptStatus,
    reason: row.reason as string,
    score: (row.score as number) ?? null,
    signals: parseJsonColumn<string[]>(row.signals, []),
    candidateId: (row.candidate_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createMemoryExtractionAttemptRepository(
  db: Database.Database,
): MemoryExtractionAttemptRepository {
  function getByPod(podId: string): MemoryExtractionAttempt | null {
    const row = db
      .prepare('SELECT * FROM memory_extraction_attempts WHERE pod_id = ?')
      .get(podId) as Record<string, unknown> | undefined;
    return row ? rowToAttempt(row) : null;
  }

  return {
    record(
      attempt: Omit<MemoryExtractionAttempt, 'id' | 'createdAt' | 'updatedAt'>,
    ): MemoryExtractionAttempt {
      const existing = getByPod(attempt.podId);
      const now = new Date().toISOString();
      const id = existing?.id ?? generateId(8);
      const createdAt = existing?.createdAt ?? now;
      db.prepare(
        `INSERT INTO memory_extraction_attempts
         (id, pod_id, profile_name, status, reason, score, signals, candidate_id, created_at, updated_at)
         VALUES
         (@id, @podId, @profileName, @status, @reason, @score, @signals, @candidateId, @createdAt, @now)
         ON CONFLICT(pod_id) DO UPDATE SET
           profile_name = excluded.profile_name,
           status = excluded.status,
           reason = excluded.reason,
           score = excluded.score,
           signals = excluded.signals,
           candidate_id = excluded.candidate_id,
           updated_at = excluded.updated_at`,
      ).run({
        id,
        podId: attempt.podId,
        profileName: attempt.profileName,
        status: attempt.status,
        reason: attempt.reason,
        score: attempt.score,
        signals: JSON.stringify(attempt.signals),
        candidateId: attempt.candidateId,
        createdAt,
        now,
      });
      return {
        ...attempt,
        id,
        createdAt,
        updatedAt: now,
      };
    },

    getByPod,

    listByProfile(profileName: string, limit = 20): MemoryExtractionAttempt[] {
      const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
      const rows = db
        .prepare(
          `SELECT * FROM memory_extraction_attempts
           WHERE profile_name = @profileName
           ORDER BY updated_at DESC
           LIMIT @limit`,
        )
        .all({ profileName, limit: safeLimit }) as Record<string, unknown>[];
      return rows.map(rowToAttempt);
    },
  };
}
