import { createHash } from 'node:crypto';
import type { ActionAuditEntry } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface AuditChainVerifyResult {
  valid: boolean;
  /** Number of rows verified. */
  rowCount: number;
  /** ID of the first row that failed verification, if any. */
  firstBadId?: number;
  reason?: string;
}

export interface ActionAuditRepository {
  insert(entry: Omit<ActionAuditEntry, 'id' | 'createdAt' | 'prevHash' | 'entryHash'>): void;
  listBySession(podId: string, limit?: number): ActionAuditEntry[];
  countBySession(podId: string): number;
  /** Verify the hash chain for all rows of a pod in insertion order. */
  verifyAuditChain(podId: string): AuditChainVerifyResult;
}

function computeEntryHash(
  prevHash: string | null,
  podId: string,
  actionName: string,
  paramsJson: string,
  responseSummary: string | null,
  quarantineScore: number,
  createdAt: string,
): string {
  return createHash('sha256')
    .update(
      `${prevHash ?? ''}|${podId}|${actionName}|${paramsJson}|${responseSummary ?? ''}|${quarantineScore}|${createdAt}`,
    )
    .digest('hex');
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
    prevHash: (row.prev_hash as string) ?? null,
    entryHash: (row.entry_hash as string) ?? null,
  };
}

export function createActionAuditRepository(db: Database.Database): ActionAuditRepository {
  return {
    insert(entry: Omit<ActionAuditEntry, 'id' | 'createdAt' | 'prevHash' | 'entryHash'>): void {
      // Fetch the hash of the most recent entry for this pod (chain link).
      const prev = db
        .prepare(
          'SELECT entry_hash FROM action_audit WHERE pod_id = @podId ORDER BY id DESC LIMIT 1',
        )
        .get({ podId: entry.podId }) as { entry_hash: string | null } | undefined;

      const prevHash = prev?.entry_hash ?? null;
      const paramsJson = JSON.stringify(entry.params);

      // We need created_at to include it in the hash; use the same value SQLite would default to.
      const createdAt = new Date().toISOString().replace('T', ' ').split('.')[0] ?? '';

      const entryHash = computeEntryHash(
        prevHash,
        entry.podId,
        entry.actionName,
        paramsJson,
        entry.responseSummary,
        entry.quarantineScore,
        createdAt,
      );

      db.prepare(
        `INSERT INTO action_audit
           (pod_id, action_name, params, response_summary, pii_detected, quarantine_score, created_at, prev_hash, entry_hash)
         VALUES
           (@podId, @actionName, @params, @responseSummary, @piiDetected, @quarantineScore, @createdAt, @prevHash, @entryHash)`,
      ).run({
        podId: entry.podId,
        actionName: entry.actionName,
        params: paramsJson,
        responseSummary: entry.responseSummary,
        piiDetected: entry.piiDetected ? 1 : 0,
        quarantineScore: entry.quarantineScore,
        createdAt,
        prevHash,
        entryHash,
      });
    },

    listBySession(podId: string, limit = 50): ActionAuditEntry[] {
      const rows = db
        .prepare('SELECT * FROM action_audit WHERE pod_id = @podId ORDER BY id DESC LIMIT @limit')
        .all({ podId, limit }) as Record<string, unknown>[];
      return rows.map(rowToAuditEntry);
    },

    countBySession(podId: string): number {
      const row = db
        .prepare('SELECT COUNT(*) as count FROM action_audit WHERE pod_id = @podId')
        .get({ podId }) as { count: number };
      return row.count;
    },

    verifyAuditChain(podId: string): AuditChainVerifyResult {
      const rows = db
        .prepare('SELECT * FROM action_audit WHERE pod_id = @podId ORDER BY id ASC')
        .all({ podId }) as Record<string, unknown>[];

      if (rows.length === 0) return { valid: true, rowCount: 0 };

      let runningPrevHash: string | null = null;
      for (const row of rows) {
        const entry = rowToAuditEntry(row);
        if (entry.entryHash === null) {
          // Pre-migration row — skip hash verification
          runningPrevHash = null;
          continue;
        }
        const expected = computeEntryHash(
          entry.prevHash,
          entry.podId,
          entry.actionName,
          JSON.stringify(entry.params),
          entry.responseSummary,
          entry.quarantineScore,
          entry.createdAt,
        );
        if (expected !== entry.entryHash) {
          return {
            valid: false,
            rowCount: rows.length,
            firstBadId: entry.id,
            reason: `entry_hash mismatch for row id=${entry.id}`,
          };
        }
        if (runningPrevHash !== null && entry.prevHash !== runningPrevHash) {
          return {
            valid: false,
            rowCount: rows.length,
            firstBadId: entry.id,
            reason: `prev_hash broken chain at row id=${entry.id}`,
          };
        }
        runningPrevHash = entry.entryHash;
      }

      return { valid: true, rowCount: rows.length };
    },
  };
}
