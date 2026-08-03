import type { ReviewBatchResult, ValidationResult } from '@autopod/shared';
import { generateId } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface StoredValidation {
  id: string;
  podId: string;
  attempt: number;
  result: ValidationResult;
  createdAt: string;
}

export interface ValidationRepository {
  insert(podId: string, attempt: number, result: ValidationResult): void;
  updateResult(podId: string, attempt: number, result: ValidationResult): boolean;
  getForSession(podId: string): StoredValidation[];
  getLatestBefore(podId: string, attempt: number): StoredValidation | null;
  getLatestReviewBatchBefore(podId: string, attempt: number): ReviewBatchResult | undefined;
}

function rowToStoredValidation(row: Record<string, unknown>): StoredValidation {
  return {
    id: row.id as string,
    podId: row.pod_id as string,
    attempt: row.attempt as number,
    result: JSON.parse(row.result as string) as ValidationResult,
    createdAt: row.created_at as string,
  };
}

export function createValidationRepository(db: Database.Database): ValidationRepository {
  return {
    insert(podId: string, attempt: number, result: ValidationResult): void {
      db.prepare(
        `INSERT INTO validations (id, pod_id, attempt, result)
         VALUES (@id, @podId, @attempt, @result)`,
      ).run({
        id: generateId(),
        podId,
        attempt,
        result: JSON.stringify(result),
      });
    },

    updateResult(podId: string, attempt: number, result: ValidationResult): boolean {
      const info = db
        .prepare(
          `UPDATE validations
           SET result = @result
           WHERE pod_id = @podId AND attempt = @attempt`,
        )
        .run({
          podId,
          attempt,
          result: JSON.stringify(result),
        });
      return info.changes > 0;
    },

    getForSession(podId: string): StoredValidation[] {
      const rows = db
        .prepare('SELECT * FROM validations WHERE pod_id = ? ORDER BY attempt ASC')
        .all(podId) as Record<string, unknown>[];
      return rows.map(rowToStoredValidation);
    },

    getLatestBefore(podId: string, attempt: number): StoredValidation | null {
      const row = db
        .prepare(
          'SELECT * FROM validations WHERE pod_id = ? AND attempt < ? ORDER BY attempt DESC LIMIT 1',
        )
        .get(podId, attempt) as Record<string, unknown> | undefined;
      return row ? rowToStoredValidation(row) : null;
    },

    getLatestReviewBatchBefore(podId: string, attempt: number): ReviewBatchResult | undefined {
      const rows = db
        .prepare('SELECT * FROM validations WHERE pod_id = ? AND attempt < ? ORDER BY attempt DESC')
        .all(podId, attempt) as Record<string, unknown>[];
      for (const row of rows) {
        const batch = rowToStoredValidation(row).result.taskReview?.reviewBatch;
        if (batch) return batch;
      }
      return undefined;
    },
  };
}
