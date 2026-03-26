import type { ValidationResult } from '@autopod/shared';
import { generateId } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface StoredValidation {
  id: string;
  sessionId: string;
  attempt: number;
  result: ValidationResult;
  screenshots: string[];
  createdAt: string;
}

export interface ValidationRepository {
  insert(sessionId: string, attempt: number, result: ValidationResult): void;
  getForSession(sessionId: string): StoredValidation[];
}

function rowToStoredValidation(row: Record<string, unknown>): StoredValidation {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    attempt: row.attempt as number,
    result: JSON.parse(row.result as string) as ValidationResult,
    screenshots: JSON.parse(row.screenshots as string) as string[],
    createdAt: row.created_at as string,
  };
}

export function createValidationRepository(db: Database.Database): ValidationRepository {
  return {
    insert(sessionId: string, attempt: number, result: ValidationResult): void {
      // Collect base64 screenshots from page results
      const screenshots: string[] = [];
      for (const page of result.smoke.pages) {
        if (page.screenshotBase64) {
          screenshots.push(page.screenshotBase64);
        }
      }

      db.prepare(
        `INSERT INTO validations (id, session_id, attempt, result, screenshots)
         VALUES (@id, @sessionId, @attempt, @result, @screenshots)`,
      ).run({
        id: generateId(),
        sessionId,
        attempt,
        result: JSON.stringify(result),
        screenshots: JSON.stringify(screenshots),
      });
    },

    getForSession(sessionId: string): StoredValidation[] {
      const rows = db
        .prepare('SELECT * FROM validations WHERE session_id = ? ORDER BY attempt ASC')
        .all(sessionId) as Record<string, unknown>[];
      return rows.map(rowToStoredValidation);
    },
  };
}
