import type { ReviewBatchResult, ValidationResult } from '@autopod/shared';
import { generateId } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface StoredValidation {
  id: string;
  podId: string;
  attempt: number;
  /** Immutable, pod-local history identity. Unlike attempt, this never resets. */
  sequence: number;
  /** Operator-visible retry/rework generation inferred when attempt restarts. */
  cycle: number;
  result: ValidationResult;
  createdAt: string;
}

export interface ValidationRepository {
  insert(podId: string, attempt: number, result: ValidationResult): StoredValidation;
  updateResult(validationId: string, result: ValidationResult): boolean;
  getForSession(podId: string): StoredValidation[];
  getLatest(podId: string): StoredValidation | null;
  getLatestReviewBatch(podId: string): ReviewBatchResult | undefined;
}

function rowToStoredValidation(row: Record<string, unknown>): StoredValidation {
  return {
    id: row.id as string,
    podId: row.pod_id as string,
    attempt: row.attempt as number,
    sequence: row.sequence as number,
    cycle: row.cycle as number,
    result: JSON.parse(row.result as string) as ValidationResult,
    createdAt: row.created_at as string,
  };
}

export function createValidationRepository(db: Database.Database): ValidationRepository {
  return {
    insert(podId: string, attempt: number, result: ValidationResult): StoredValidation {
      return db.transaction(() => {
        const latest = db
          .prepare(
            `SELECT attempt, sequence, cycle
             FROM validations
             WHERE pod_id = ?
             ORDER BY sequence DESC
             LIMIT 1`,
          )
          .get(podId) as { attempt: number; sequence: number; cycle: number } | undefined;
        const id = generateId();
        const sequence = (latest?.sequence ?? 0) + 1;
        const cycle = latest ? latest.cycle + (attempt <= latest.attempt ? 1 : 0) : 0;
        db.prepare(
          `INSERT INTO validations (id, pod_id, attempt, sequence, cycle, result)
           VALUES (@id, @podId, @attempt, @sequence, @cycle, @result)`,
        ).run({
          id,
          podId,
          attempt,
          sequence,
          cycle,
          result: JSON.stringify(result),
        });
        const inserted = db.prepare('SELECT * FROM validations WHERE id = ?').get(id) as
          | Record<string, unknown>
          | undefined;
        if (!inserted) throw new Error(`Validation history insert ${id} could not be read back`);
        return rowToStoredValidation(inserted);
      })();
    },

    updateResult(validationId: string, result: ValidationResult): boolean {
      const info = db
        .prepare(
          `UPDATE validations
           SET result = @result
           WHERE id = @validationId`,
        )
        .run({
          validationId,
          result: JSON.stringify(result),
        });
      return info.changes > 0;
    },

    getForSession(podId: string): StoredValidation[] {
      const rows = db
        .prepare('SELECT * FROM validations WHERE pod_id = ? ORDER BY sequence ASC')
        .all(podId) as Record<string, unknown>[];
      return rows.map(rowToStoredValidation);
    },

    getLatest(podId: string): StoredValidation | null {
      const row = db
        .prepare('SELECT * FROM validations WHERE pod_id = ? ORDER BY sequence DESC LIMIT 1')
        .get(podId) as Record<string, unknown> | undefined;
      return row ? rowToStoredValidation(row) : null;
    },

    getLatestReviewBatch(podId: string): ReviewBatchResult | undefined {
      const rows = db
        .prepare('SELECT * FROM validations WHERE pod_id = ? ORDER BY sequence DESC')
        .all(podId) as Record<string, unknown>[];
      for (const row of rows) {
        const batch = rowToStoredValidation(row).result.taskReview?.reviewBatch;
        if (batch) return batch;
      }
      return undefined;
    },
  };
}
