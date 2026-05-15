import { randomUUID } from 'node:crypto';
import type { FixFeedback } from '@autopod/shared';
import type Database from 'better-sqlite3';

export type { FixFeedback };

export interface FixFeedbackRepository {
  enqueue(podId: string, message: string): FixFeedback;
  peek(podId: string): FixFeedback[];
  peekLatest(podId: string): FixFeedback | null;
  drain(podId: string): FixFeedback[];
  count(podId: string): number;
}

export function createFixFeedbackRepository(db: Database.Database): FixFeedbackRepository {
  return {
    enqueue(podId: string, message: string): FixFeedback {
      const row: FixFeedback = {
        id: randomUUID(),
        podId,
        message,
        createdAt: Date.now(),
      };
      db.prepare(
        `INSERT INTO pending_fix_feedback (id, pod_id, message, created_at)
         VALUES (@id, @podId, @message, @createdAt)`,
      ).run({ id: row.id, podId: row.podId, message: row.message, createdAt: row.createdAt });
      return row;
    },

    peek(podId: string): FixFeedback[] {
      return db
        .prepare(
          `SELECT id, pod_id AS podId, message, created_at AS createdAt
           FROM pending_fix_feedback
           WHERE pod_id = ?
           ORDER BY created_at ASC`,
        )
        .all(podId) as FixFeedback[];
    },

    peekLatest(podId: string): FixFeedback | null {
      const row = db
        .prepare(
          `SELECT id, pod_id AS podId, message, created_at AS createdAt
           FROM pending_fix_feedback
           WHERE pod_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get(podId) as FixFeedback | undefined;
      return row ?? null;
    },

    drain(podId: string): FixFeedback[] {
      return db.transaction(() => {
        const rows = db
          .prepare(
            `SELECT id, pod_id AS podId, message, created_at AS createdAt
             FROM pending_fix_feedback
             WHERE pod_id = ?
             ORDER BY created_at ASC`,
          )
          .all(podId) as FixFeedback[];
        db.prepare(`DELETE FROM pending_fix_feedback WHERE pod_id = ?`).run(podId);
        return rows;
      })();
    },

    count(podId: string): number {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM pending_fix_feedback WHERE pod_id = ?`)
        .get(podId) as { n: number };
      return row.n;
    },
  };
}
