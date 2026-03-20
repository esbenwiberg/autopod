import type Database from 'better-sqlite3';
import type { ActionAuditEntry } from '@autopod/shared';

export interface ActionAuditRepository {
  insert(entry: Omit<ActionAuditEntry, 'id' | 'createdAt'>): void;
  listBySession(sessionId: string, limit?: number): ActionAuditEntry[];
  countBySession(sessionId: string): number;
}

function rowToAuditEntry(row: Record<string, unknown>): ActionAuditEntry {
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    actionName: row.action_name as string,
    params: JSON.parse(row.params as string) as Record<string, unknown>,
    responseSummary: (row.response_summary as string) ?? null,
    piiDetected: (row.pii_detected as number) === 1,
    quarantineScore: row.quarantine_score as number,
    createdAt: row.created_at as string,
  };
}

export function createActionAuditRepository(db: Database.Database): ActionAuditRepository {
  return {
    insert(entry: Omit<ActionAuditEntry, 'id' | 'createdAt'>): void {
      db.prepare(
        `INSERT INTO action_audit (session_id, action_name, params, response_summary, pii_detected, quarantine_score)
         VALUES (@sessionId, @actionName, @params, @responseSummary, @piiDetected, @quarantineScore)`,
      ).run({
        sessionId: entry.sessionId,
        actionName: entry.actionName,
        params: JSON.stringify(entry.params),
        responseSummary: entry.responseSummary,
        piiDetected: entry.piiDetected ? 1 : 0,
        quarantineScore: entry.quarantineScore,
      });
    },

    listBySession(sessionId: string, limit = 50): ActionAuditEntry[] {
      const rows = db
        .prepare('SELECT * FROM action_audit WHERE session_id = @sessionId ORDER BY created_at DESC LIMIT @limit')
        .all({ sessionId, limit }) as Record<string, unknown>[];
      return rows.map(rowToAuditEntry);
    },

    countBySession(sessionId: string): number {
      const row = db
        .prepare('SELECT COUNT(*) as count FROM action_audit WHERE session_id = @sessionId')
        .get({ sessionId }) as { count: number };
      return row.count;
    },
  };
}
