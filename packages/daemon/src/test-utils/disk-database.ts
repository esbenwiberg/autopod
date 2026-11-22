import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrate.js';
import { logger } from './mock-helpers.js';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../db/migrations');

/**
 * Ascending schema versions of the `.sql` migrations in `dir`, read from the files themselves.
 * Upgrade tests derive the expected latest version (and expected applied tails) from this rather
 * than hardcoding the current tip, so adding the next migration does not break them.
 */
export function migrationVersions(dir: string = MIGRATIONS_DIR): number[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => Number.parseInt(name, 10))
    .sort((a, b) => a - b);
}

/** Highest schema version in `dir`: what a full upgrade must leave as `MAX(version)`. */
export function latestMigrationVersion(dir: string = MIGRATIONS_DIR): number {
  const versions = migrationVersions(dir);
  const latest = versions.at(-1);
  if (latest === undefined) throw new Error(`No migrations in ${dir}`);
  return latest;
}

/**
 * Opens an on-disk test database with the daemon's production connection policy: WAL,
 * synchronous=NORMAL, busy timeout and foreign keys (`createDatabase`).
 *
 * Do not open writable on-disk test databases with the bare better-sqlite3 constructor. Its
 * rollback journal with synchronous=FULL fsyncs every commit, which is once per migration in a
 * schema replay. On the shared Docker overlay disk of concurrently validating pods those fsyncs
 * multiplied functional upgrade tests several times over and pushed them past their deadlines.
 * Restart/reopen tests stay real persistence checks; they are not power-loss simulations.
 * Read-only, journal-mode and legacy-checkpoint compatibility fixtures stay deliberately distinct.
 */
export function openTestDiskDatabase(file: string): Database.Database {
  return createDatabase(file, logger);
}

/** One directory of real migration files, restricted to versions `<= through`. */
export interface MigrationSelection {
  dir: string;
  through: number;
  /** Versions deliberately left out, for example an unpublished lineage that skipped one. */
  except?: readonly number[];
}

const historicalTemplates = new Map<string, Buffer>();

function selectedMigrations(selections: readonly MigrationSelection[]) {
  return selections.flatMap(({ dir, through, except = [] }) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .filter((name) => {
        const version = Number.parseInt(name, 10);
        return version <= through && !except.includes(version);
      })
      .sort()
      .map((name) => ({ name, file: path.join(dir, name) })),
  );
}

/**
 * Writes a database at a historical schema to `file` and opens it with the production policy.
 *
 * The schema comes from the real migration runner applied to exactly the selected files (later
 * selections replace same-named earlier ones, as when copied into one directory). It is built once
 * per selection per test module, in memory, so the old prefix costs neither a replay per test nor
 * an fsync per migration. Every caller receives a private file; the upgrade under test still runs
 * against that on-disk database, including any cutover backups.
 */
export function createHistoricalDiskDatabase(
  file: string,
  selections: readonly MigrationSelection[],
): Database.Database {
  const migrations = new Map(selectedMigrations(selections).map((m) => [m.name, m.file]));
  const key = JSON.stringify([...migrations]);
  let template = historicalTemplates.get(key);
  if (!template) {
    const dir = mkdtempSync(path.join(tmpdir(), 'historical-schema-'));
    const memory = new Database(':memory:');
    try {
      for (const [name, source] of migrations) copyFileSync(source, path.join(dir, name));
      // Same connection setting as createDatabase; the runner toggles it around FK-off migrations.
      memory.pragma('foreign_keys = ON');
      runMigrations(memory, dir, logger);
      template = memory.serialize();
      historicalTemplates.set(key, template);
    } finally {
      memory.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  writeFileSync(file, template);
  return openTestDiskDatabase(file);
}
