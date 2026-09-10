import { generatePodId } from '@autopod/shared';
import type Database from 'better-sqlite3';
import {
  type HistoryDiagnosticSink,
  readRetainedHistory,
} from '../history/retained-history-read.js';

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
  listBySession(
    podId: string,
    includeRetained?: boolean,
    diagnostic?: HistoryDiagnosticSink,
  ): ProgressEventRecord[];
}

export function createProgressEventRepository(db: Database.Database): ProgressEventRepository {
  return {
    insert(podId, phase, description, currentPhase, totalPhases): void {
      db.prepare(`
        INSERT INTO session_progress_events (id, pod_id, phase, description, current_phase, total_phases)
        VALUES (@id, @podId, @phase, @description, @currentPhase, @totalPhases)
      `).run({ id: generatePodId(), podId, phase, description, currentPhase, totalPhases });
    },

    listBySession(
      podId,
      includeRetained = false,
      diagnostic?: HistoryDiagnosticSink,
    ): ProgressEventRecord[] {
      const decode = (row: Record<string, unknown>): ProgressEventRecord => ({
        id: row.id as string,
        podId: row.pod_id as string,
        phase: row.phase as string,
        description: row.description as string,
        currentPhase: row.current_phase as number,
        totalPhases: row.total_phases as number,
        createdAt: row.created_at as string,
      });
      if (includeRetained && diagnostic)
        return readRetainedHistory(db, 'session_progress_events', podId, decode, diagnostic);
      const rows = db
        .prepare(
          `SELECT * FROM ${includeRetained ? 'retained_session_progress_events' : 'session_progress_events'} WHERE pod_id = ? ORDER BY created_at ASC`,
        )
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
