import type { EscalationRequest, EscalationResponse, EscalationType } from '@autopod/shared';
import { EscalationNotFoundError } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface EscalationRow {
  id: string;
  podId: string;
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
  listBySession(podId: string): EscalationRow[];
  countBySessionAndType(podId: string, type: EscalationType): number;
}

function rowToEscalation(row: Record<string, unknown>): EscalationRow {
  return {
    id: row.id as string,
    podId: row.pod_id as string,
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
        'INSERT INTO escalations (id, pod_id, type, payload) VALUES (@id, @podId, @type, @payload)',
      ).run({
        id: escalation.id,
        podId: escalation.podId,
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

    listBySession(podId: string): EscalationRow[] {
      const rows = db
        .prepare('SELECT * FROM escalations WHERE pod_id = ? ORDER BY created_at ASC')
        .all(podId) as Record<string, unknown>[];
      return rows.map(rowToEscalation);
    },

    countBySessionAndType(podId: string, type: EscalationType): number {
      const row = db
        .prepare(
          'SELECT COUNT(*) as count FROM escalations WHERE pod_id = @podId AND type = @type',
        )
        .get({ podId, type }) as { count: number };
      return row.count;
    },
  };
}
