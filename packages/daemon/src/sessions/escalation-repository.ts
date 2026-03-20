import type { EscalationRequest, EscalationResponse, EscalationType } from '@autopod/shared';
import { EscalationNotFoundError } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface EscalationRow {
  id: string;
  sessionId: string;
  type: EscalationType;
  payload: EscalationRequest['payload'];
  response: EscalationResponse | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface EscalationRepository {
  insert(escalation: EscalationRequest): void;
  getOrThrow(id: string): EscalationRow;
  update(id: string, response: EscalationResponse): void;
  countBySessionAndType(sessionId: string, type: EscalationType): number;
}

function rowToEscalation(row: Record<string, unknown>): EscalationRow {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    type: row.type as EscalationType,
    payload: JSON.parse(row.payload as string) as EscalationRequest['payload'],
    response: row.response ? (JSON.parse(row.response as string) as EscalationResponse) : null,
    createdAt: row.created_at as string,
    resolvedAt: (row.resolved_at as string) ?? null,
  };
}

export function createEscalationRepository(db: Database.Database): EscalationRepository {
  return {
    insert(escalation: EscalationRequest): void {
      db.prepare(
        'INSERT INTO escalations (id, session_id, type, payload) VALUES (@id, @sessionId, @type, @payload)',
      ).run({
        id: escalation.id,
        sessionId: escalation.sessionId,
        type: escalation.type,
        payload: JSON.stringify(escalation.payload),
      });
    },

    getOrThrow(id: string): EscalationRow {
      const row = db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) {
        throw new EscalationNotFoundError(id);
      }
      return rowToEscalation(row);
    },

    update(id: string, response: EscalationResponse): void {
      const result = db
        .prepare(
          'UPDATE escalations SET response = @response, resolved_at = @resolvedAt WHERE id = @id',
        )
        .run({
          id,
          response: JSON.stringify(response),
          resolvedAt: new Date().toISOString(),
        });

      if (result.changes === 0) {
        throw new EscalationNotFoundError(id);
      }
    },

    countBySessionAndType(sessionId: string, type: EscalationType): number {
      const row = db
        .prepare(
          'SELECT COUNT(*) as count FROM escalations WHERE session_id = @sessionId AND type = @type',
        )
        .get({ sessionId, type }) as { count: number };
      return row.count;
    },
  };
}
