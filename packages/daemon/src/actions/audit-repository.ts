import type { ActionAuditEntry } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface ActionAuditRepository {
  insert(entry: Omit<ActionAuditEntry, 'id' | 'createdAt'>): void;
  listBySession(podId: string, limit?: number): ActionAuditEntry[];
  countBySession(podId: string): number;
}

function rowToAuditEntry(row: Record<string, unknown>): ActionAuditEntry {
  return {
    id: row.id as number,
    podId: row.pod_id as string,
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
        `INSERT INTO action_audit (pod_id, action_name, params, response_summary, pii_detected, quarantine_score)
         VALUES (@podId, @actionName, @params, @responseSummary, @piiDetected, @quarantineScore)`,
      ).run({
        podId: entry.podId,
        actionName: entry.actionName,
        params: JSON.stringify(entry.params),
        responseSummary: entry.responseSummary,
        piiDetected: entry.piiDetected ? 1 : 0,
        quarantineScore: entry.quarantineScore,
      });
    },

    listBySession(podId: string, limit = 50): ActionAuditEntry[] {
      const rows = db
        .prepare(
          'SELECT * FROM action_audit WHERE pod_id = @podId ORDER BY created_at DESC LIMIT @limit',
        )
        .all({ podId, limit }) as Record<string, unknown>[];
      return rows.map(rowToAuditEntry);
    },

    countBySession(podId: string): number {
      const row = db
        .prepare('SELECT COUNT(*) as count FROM action_audit WHERE pod_id = @podId')
        .get({ podId }) as { count: number };
      return row.count;
    },
  };
}
