import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { digest } from '../managed/canonical.js';

/** OS-released writer lock spanning one async local recovery operation. Never hold the
 * application DB write lock while awaiting Git or a backend. A bounded set of sibling
 * lock files lives with the local SQLite database (not disposable mirror scratch).
 * Colliding slots defer to the next pass. Never unlink a slot while hosts are active. */
export function tryRecoveryClaim(
  db: Database.Database,
  run: string,
  key: string,
): (() => void) | null {
  const dir = realpathSync(db.name) + '.continuation-locks';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const slot = digest([run, key]).slice(-2);
  const lock = new Database(path.join(dir, slot), { timeout: 0 });
  try {
    lock.exec('BEGIN IMMEDIATE');
    return () => lock.close();
  } catch (error) {
    lock.close();
    if (error instanceof Database.SqliteError && error.code === 'SQLITE_BUSY') return null;
    throw error;
  }
}
