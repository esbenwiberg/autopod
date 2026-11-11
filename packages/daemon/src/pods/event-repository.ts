import type { SystemEvent } from '@autopod/shared';
import type Database from 'better-sqlite3';
import {
  type HistoryDiagnosticSink,
  readRetainedHistory,
} from '../history/retained-history-read.js';

export interface StoredEvent {
  id: number;
  podId: string | null;
  type: string;
  payload: SystemEvent;
  createdAt: string;
}

export interface EventRepository {
  /** Bounded scalar-only visible history. Never loads tool/reasoning/credential bodies. */
  getVisibleRecoveryText?(podId: string): {
    messages: Array<{
      eventId: number;
      role: 'human' | 'assistant';
      text: string;
      timestamp: string;
    }>;
    truncated: boolean;
  };
  insert(event: SystemEvent): number; // returns auto-increment id
  getSince(lastId: number, limit?: number): StoredEvent[];
  countForSession(podId: string, type: string): number;
  getForSession(
    podId: string,
    options?: {
      type?: string;
      types?: string[];
      latest?: number;
      includeRetained?: boolean;
      diagnostic?: HistoryDiagnosticSink;
    },
  ): StoredEvent[];
}

/** Extract podId from event payload if present. */
function extractSessionId(event: SystemEvent): string | null {
  if ('podId' in event && typeof event.podId === 'string') {
    return event.podId;
  }
  if ('pod' in event && event.pod && typeof event.pod === 'object' && 'id' in event.pod) {
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
    getVisibleRecoveryText(podId) {
      const rows = db
        .prepare(`WITH visible AS (
        SELECT id AS eventId,created_at AS timestamp,
        CASE WHEN type='pod.escalation_resolved' THEN 'human' ELSE 'assistant' END AS role,
        CASE WHEN type='pod.escalation_resolved' THEN json_extract(payload,'$.response.response')
          WHEN json_extract(payload,'$.event.type')='complete' THEN json_extract(payload,'$.event.result')
          ELSE json_extract(payload,'$.event.message') END AS text
        FROM events e WHERE e.pod_id=? AND json_valid(e.payload) AND (
          (e.type='pod.agent_activity' AND json_extract(e.payload,'$.event.type') IN ('complete','status'))
          OR (e.type='pod.escalation_resolved' AND json_extract(e.payload,'$.response.respondedBy')='human'
            AND EXISTS(SELECT 1 FROM events q WHERE q.pod_id=e.pod_id AND q.type='pod.escalation_created'
              AND json_valid(q.payload) AND json_extract(q.payload,'$.escalation.type')='ask_human'
              AND json_extract(q.payload,'$.escalation.id')=json_extract(e.payload,'$.escalationId')))))
        SELECT eventId,timestamp,role,substr(text,1,4001) AS text FROM visible
        WHERE typeof(text)='text' ORDER BY eventId DESC LIMIT 201`)
        .all(podId) as Array<{
        eventId: number;
        role: 'human' | 'assistant';
        text: string;
        timestamp: string;
      }>;
      return {
        messages: rows.slice(0, 200).reverse(),
        truncated: rows.length > 200 || rows.some((r) => r.text.length > 4000),
      };
    },
    insert(event: SystemEvent): number {
      const podId = extractSessionId(event);
      const result = db
        .prepare('INSERT INTO events (pod_id, type, payload) VALUES (@podId, @type, @payload)')
        .run({
          podId,
          type: event.type,
          payload: JSON.stringify(event),
        });
      return Number(result.lastInsertRowid);
    },

    getSince(lastId: number, limit?: number): StoredEvent[] {
      const rows =
        limit === undefined
          ? (db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC').all(lastId) as Record<
              string,
              unknown
            >[])
          : (db
              .prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?')
              .all(lastId, limit) as Record<string, unknown>[]);
      return rows.map(rowToStoredEvent);
    },

    countForSession(podId: string, type: string): number {
      const row = db
        .prepare('SELECT COUNT(*) AS count FROM events WHERE pod_id = @podId AND type = @type')
        .get({ podId, type }) as { count: number };
      return row.count;
    },

    getForSession(podId: string, options = {}): StoredEvent[] {
      if (options.includeRetained && options.diagnostic)
        return readRetainedHistory(db, 'events', podId, rowToStoredEvent, options.diagnostic);
      const clauses = ['pod_id = @podId'];
      const params: Record<string, string | number> = { podId };
      if (options.type) {
        clauses.push('type = @type');
        params.type = options.type;
      } else if (options.types?.length) {
        const typeParams = options.types.map((type, index) => {
          const key = `type${index}`;
          params[key] = type;
          return `@${key}`;
        });
        clauses.push(`type IN (${typeParams.join(', ')})`);
      }

      const where = clauses.join(' AND ');
      const table = options.includeRetained ? 'retained_events' : 'events';
      const rows =
        options.latest === undefined
          ? (db
              .prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY id ASC`)
              .all(params) as Record<string, unknown>[])
          : (db
              .prepare(
                `SELECT * FROM (
                  SELECT * FROM ${table} WHERE ${where} ORDER BY id DESC LIMIT @latest
                ) ORDER BY id ASC`,
              )
              .all({ ...params, latest: options.latest }) as Record<string, unknown>[]);
      return rows.map(rowToStoredEvent);
    },
  };
}
