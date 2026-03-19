import type Database from 'better-sqlite3';

export interface NudgeMessage {
  id: number;
  sessionId: string;
  message: string;
  consumed: boolean;
  createdAt: string;
  consumedAt: string | null;
}

export interface NudgeRepository {
  queue(sessionId: string, message: string): void;
  consumeNext(sessionId: string): { hasMessage: boolean; message?: string };
  listPending(sessionId: string): NudgeMessage[];
}

export function createNudgeRepository(db: Database.Database): NudgeRepository {
  return {
    queue(sessionId: string, message: string): void {
      db.prepare(
        'INSERT INTO nudge_messages (session_id, message, created_at) VALUES (?, ?, ?)',
      ).run(sessionId, message, new Date().toISOString());
    },

    consumeNext(sessionId: string): { hasMessage: boolean; message?: string } {
      const row = db
        .prepare(
          'SELECT id, message FROM nudge_messages WHERE session_id = ? AND consumed = 0 ORDER BY id ASC LIMIT 1',
        )
        .get(sessionId) as { id: number; message: string } | undefined;

      if (!row) return { hasMessage: false };

      db.prepare(
        'UPDATE nudge_messages SET consumed = 1, consumed_at = ? WHERE id = ?',
      ).run(new Date().toISOString(), row.id);

      return { hasMessage: true, message: row.message };
    },

    listPending(sessionId: string): NudgeMessage[] {
      const rows = db
        .prepare(
          'SELECT * FROM nudge_messages WHERE session_id = ? AND consumed = 0 ORDER BY id ASC',
        )
        .all(sessionId) as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        id: row.id as number,
        sessionId: row.session_id as string,
        message: row.message as string,
        consumed: Boolean(row.consumed),
        createdAt: row.created_at as string,
        consumedAt: (row.consumed_at as string) ?? null,
      }));
    },
  };
}
