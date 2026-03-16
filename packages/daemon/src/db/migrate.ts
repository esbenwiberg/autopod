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

    const migrate = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    });

    migrate();
    applied++;
    logger.info({ version, file }, 'Applied migration');
  }

  if (applied === 0) {
    logger.info({ currentVersion }, 'Database schema is up to date');
  } else {
    logger.info({ applied, newVersion: currentVersion + applied }, 'Migrations complete');
  }
}
