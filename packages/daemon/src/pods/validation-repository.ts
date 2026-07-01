import type { ValidationResult } from '@autopod/shared';
import { generateId } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface StoredValidation {
  id: string;
  podId: string;
  attempt: number;
  reworkCount: number;
  result: ValidationResult;
  createdAt: string;
}

export interface ValidationRepository {
  insert(podId: string, attempt: number, result: ValidationResult, reworkCount: number): void;
  updateResult(
    podId: string,
    attempt: number,
    result: ValidationResult,
    reworkCount: number,
  ): boolean;
  getForSession(podId: string): StoredValidation[];
}

function rowToStoredValidation(row: Record<string, unknown>): StoredValidation {
  return {
    id: row.id as string,
    podId: row.pod_id as string,
    attempt: row.attempt as number,
    reworkCount: (row.rework_count as number | null) ?? 0,
    result: JSON.parse(row.result as string) as ValidationResult,
    createdAt: row.created_at as string,
  };
}

export function createValidationRepository(db: Database.Database): ValidationRepository {
  return {
    insert(podId: string, attempt: number, result: ValidationResult, reworkCount: number): void {
      db.prepare(
        `INSERT INTO validations (id, pod_id, attempt, rework_count, result)
         VALUES (@id, @podId, @attempt, @reworkCount, @result)`,
      ).run({
        id: generateId(),
        podId,
        attempt,
        reworkCount,
        result: JSON.stringify(result),
      });
    },

    updateResult(
      podId: string,
      attempt: number,
      result: ValidationResult,
      reworkCount: number,
    ): boolean {
      const info = db
        .prepare(
          `UPDATE validations
           SET result = @result
           WHERE pod_id = @podId AND attempt = @attempt AND rework_count = @reworkCount`,
        )
        .run({
          podId,
          attempt,
          reworkCount,
          result: JSON.stringify(result),
        });
      return info.changes > 0;
    },

    getForSession(podId: string): StoredValidation[] {
      const rows = db
        .prepare(
          'SELECT * FROM validations WHERE pod_id = ? ORDER BY rework_count ASC, attempt ASC',
        )
        .all(podId) as Record<string, unknown>[];
      return rows.map(rowToStoredValidation);
    },
  };
}
