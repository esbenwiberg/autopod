import type { ValidationOverride } from '@autopod/shared';
import { generateId } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface PendingOverrideRepository {
  /** Add an override to the queue for the given pod. */
  enqueue(podId: string, override: Omit<ValidationOverride, 'createdAt'>): void;
  /** Return all pending overrides for the pod and clear the queue. */
  flush(podId: string): ValidationOverride[];
  /** List pending overrides without consuming them (for display purposes). */
  list(podId: string): ValidationOverride[];
}

function rowToOverride(row: Record<string, unknown>): ValidationOverride {
  return {
    findingId: row.finding_id as string,
    description: row.description as string,
    action: row.action as ValidationOverride['action'],
    reason: (row.reason as string | null) ?? undefined,
    guidance: (row.guidance as string | null) ?? undefined,
    createdAt: row.created_at as string,
  };
}

export function createPendingOverrideRepository(db: Database.Database): PendingOverrideRepository {
  return {
    enqueue(podId: string, override: Omit<ValidationOverride, 'createdAt'>): void {
      db.prepare(
        `INSERT INTO pending_validation_overrides
         (id, pod_id, finding_id, description, action, reason, guidance)
         VALUES (@id, @podId, @findingId, @description, @action, @reason, @guidance)`,
      ).run({
        id: generateId(),
        podId,
        findingId: override.findingId,
        description: override.description,
        action: override.action,
        reason: override.reason ?? null,
        guidance: override.guidance ?? null,
      });
    },

    flush(podId: string): ValidationOverride[] {
      const rows = db
        .prepare(
          'SELECT * FROM pending_validation_overrides WHERE pod_id = ? ORDER BY created_at ASC',
        )
        .all(podId) as Record<string, unknown>[];

      if (rows.length > 0) {
        db.prepare('DELETE FROM pending_validation_overrides WHERE pod_id = ?').run(podId);
      }

      return rows.map(rowToOverride);
    },

    list(podId: string): ValidationOverride[] {
      const rows = db
        .prepare(
          'SELECT * FROM pending_validation_overrides WHERE pod_id = ? ORDER BY created_at ASC',
        )
        .all(podId) as Record<string, unknown>[];
      return rows.map(rowToOverride);
    },
  };
}
