import type { SystemEvent } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface StoredEvent {
  id: number;
  podId: string | null;
  type: string;
  payload: SystemEvent;
  createdAt: string;
}

export interface EventRepository {
  insert(event: SystemEvent): number; // returns auto-increment id
  getSince(lastId: number): StoredEvent[];
  getForSession(podId: string): StoredEvent[];
}

/** Extract podId from event payload if present. */
function extractSessionId(event: SystemEvent): string | null {
  if ('podId' in event && typeof event.podId === 'string') {
    return event.podId;
  }
  if (
    'pod' in event &&
    event.pod &&
    typeof event.pod === 'object' &&
    'id' in event.pod
  ) {
    return (event.pod as { id: string }).id;
  }
  return null;
}

function rowToStoredEvent(row: Record<string, unknown>): StoredEvent {
  return {
    id: row.id as number,
    podId: (row.pod_id as string) ?? null,
    type: row.type as string,
    payload: JSON.parse(row.payload as string) as SystemEvent,
    createdAt: row.created_at as string,
  };
}

export function createEventRepository(db: Database.Database): EventRepository {
  return {
    insert(event: SystemEvent): number {
      const podId = extractSessionId(event);
      const result = db
        .prepare(
          'INSERT INTO events (pod_id, type, payload) VALUES (@podId, @type, @payload)',
        )
        .run({
          podId,
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

    getForSession(podId: string): StoredEvent[] {
      const rows = db
        .prepare('SELECT * FROM events WHERE pod_id = ? ORDER BY id ASC')
        .all(podId) as Record<string, unknown>[];
      return rows.map(rowToStoredEvent);
    },
  };
}
