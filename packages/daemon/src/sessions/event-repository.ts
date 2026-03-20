import type { SystemEvent } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface StoredEvent {
  id: number;
  sessionId: string | null;
  type: string;
  payload: SystemEvent;
  createdAt: string;
}

export interface EventRepository {
  insert(event: SystemEvent): number; // returns auto-increment id
  getSince(lastId: number): StoredEvent[];
  getForSession(sessionId: string): StoredEvent[];
}

/** Extract sessionId from event payload if present. */
function extractSessionId(event: SystemEvent): string | null {
  if ('sessionId' in event && typeof event.sessionId === 'string') {
    return event.sessionId;
  }
  if (
    'session' in event &&
    event.session &&
    typeof event.session === 'object' &&
    'id' in event.session
  ) {
    return (event.session as { id: string }).id;
  }
  return null;
}

function rowToStoredEvent(row: Record<string, unknown>): StoredEvent {
  return {
    id: row.id as number,
    sessionId: (row.session_id as string) ?? null,
    type: row.type as string,
    payload: JSON.parse(row.payload as string) as SystemEvent,
    createdAt: row.created_at as string,
  };
}

export function createEventRepository(db: Database.Database): EventRepository {
  return {
    insert(event: SystemEvent): number {
      const sessionId = extractSessionId(event);
      const result = db
        .prepare(
          'INSERT INTO events (session_id, type, payload) VALUES (@sessionId, @type, @payload)',
        )
        .run({
          sessionId,
          type: event.type,
          payload: JSON.stringify(event),
        });
      return Number(result.lastInsertRowid);
    },

    getSince(lastId: number): StoredEvent[] {
      const rows = db
        .prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC')
        .all(lastId) as Record<string, unknown>[];
      return rows.map(rowToStoredEvent);
    },

    getForSession(sessionId: string): StoredEvent[] {
      const rows = db
        .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id ASC')
        .all(sessionId) as Record<string, unknown>[];
      return rows.map(rowToStoredEvent);
    },
  };
}
