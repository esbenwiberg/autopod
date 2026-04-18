import { generatePodId } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface ProgressEventRecord {
  id: string;
  podId: string;
  phase: string;
  description: string;
  currentPhase: number;
  totalPhases: number;
  createdAt: string;
}

export interface ProgressEventRepository {
  insert(
    podId: string,
    phase: string,
    description: string,
    currentPhase: number,
    totalPhases: number,
  ): void;
  listBySession(podId: string): ProgressEventRecord[];
}

export function createProgressEventRepository(db: Database.Database): ProgressEventRepository {
  return {
    insert(podId, phase, description, currentPhase, totalPhases): void {
      db.prepare(`
        INSERT INTO session_progress_events (id, pod_id, phase, description, current_phase, total_phases)
        VALUES (@id, @podId, @phase, @description, @currentPhase, @totalPhases)
      `).run({ id: generatePodId(), podId, phase, description, currentPhase, totalPhases });
    },

    listBySession(podId): ProgressEventRecord[] {
      const rows = db
        .prepare('SELECT * FROM session_progress_events WHERE pod_id = ? ORDER BY created_at ASC')
        .all(podId) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: row.id as string,
        podId: row.pod_id as string,
        phase: row.phase as string,
        description: row.description as string,
        currentPhase: row.current_phase as number,
        totalPhases: row.total_phases as number,
        createdAt: row.created_at as string,
      }));
    },
  };
}
