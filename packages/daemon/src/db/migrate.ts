import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

export function runMigrations(db: Database.Database, migrationsDir: string, logger: Logger): void {
  // Ensure schema_version table exists (bootstrap)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Get current version
  const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as
    | { version: number | null }
    | undefined;
  const currentVersion = row?.version ?? 0;

  // Find migration files
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let applied = 0;

  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match?.[1]) {
      logger.warn({ file }, 'Skipping migration file with invalid name');
      continue;
    }

    const version = Number.parseInt(match[1], 10);
    if (version <= currentVersion) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

    // PRAGMA foreign_keys = OFF/ON must be set at the connection level — they are
    // silently ignored when executed inside a transaction. Detect migrations that
    // need FK enforcement suspended and toggle it around the transaction.
    const needsFkDisabled = /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql);
    if (needsFkDisabled) {
      db.pragma('foreign_keys = OFF');
    }

    // Opt-in marker for repair migrations that re-assert ALTER TABLE ADD COLUMN
    // statements which may or may not already be applied (SQLite lacks
    // IF NOT EXISTS for ADD COLUMN). When present, split on `;` and swallow
    // only "duplicate column name" errors per statement.
    const allowDuplicateColumns = /--\s*@allow-duplicate-columns/i.test(sql);

    const migrate = db.transaction(() => {
      if (allowDuplicateColumns) {
        const statements = sql
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        for (const stmt of statements) {
          try {
            db.exec(`${stmt};`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : '';
            if (!msg.includes('duplicate column name')) throw err;
            logger.debug({ stmt, file }, 'Skipping already-applied ADD COLUMN');
          }
        }
      } else {
        db.exec(sql);
      }
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    });

    try {
      migrate();
    } finally {
      if (needsFkDisabled) {
        db.pragma('foreign_keys = ON');
      }
    }
    applied++;
    logger.info({ version, file }, 'Applied migration');
  }

  if (applied === 0) {
    logger.info({ currentVersion }, 'Database schema is up to date');
  } else {
    logger.info({ applied, newVersion: currentVersion + applied }, 'Migrations complete');
  }
}
