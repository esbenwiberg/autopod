import { generateSessionId } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface ProgressEventRecord {
  id: string;
  sessionId: string;
  phase: string;
  description: string;
  currentPhase: number;
  totalPhases: number;
  createdAt: string;
}

export interface ProgressEventRepository {
  insert(
    sessionId: string,
    phase: string,
    description: string,
    currentPhase: number,
    totalPhases: number,
  ): void;
  listBySession(sessionId: string): ProgressEventRecord[];
}

export function createProgressEventRepository(db: Database.Database): ProgressEventRepository {
  return {
    insert(sessionId, phase, description, currentPhase, totalPhases): void {
      db.prepare(`
        INSERT INTO session_progress_events (id, session_id, phase, description, current_phase, total_phases)
        VALUES (@id, @sessionId, @phase, @description, @currentPhase, @totalPhases)
      `).run({ id: generateSessionId(), sessionId, phase, description, currentPhase, totalPhases });
    },

    listBySession(sessionId): ProgressEventRecord[] {
      const rows = db
        .prepare(
          'SELECT * FROM session_progress_events WHERE session_id = ? ORDER BY created_at ASC',
        )
        .all(sessionId) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: row.id as string,
        sessionId: row.session_id as string,
        phase: row.phase as string,
        description: row.description as string,
        currentPhase: row.current_phase as number,
        totalPhases: row.total_phases as number,
        createdAt: row.created_at as string,
      }));
    },
  };
}
