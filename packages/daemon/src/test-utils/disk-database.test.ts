import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDatabase } from '../db/connection.js';
import { runMigrations, runMigrationsWithBackups } from '../db/migrate.js';
import {
  createHistoricalDiskDatabase,
  MIGRATIONS_DIR,
  openTestDiskDatabase,
} from './disk-database.js';
import { logger } from './mock-helpers.js';

const roots: string[] = [];
const databases: Database.Database[] = [];
function root() {
  const dir = mkdtempSync(path.join(tmpdir(), 'disk-database-test-'));
  roots.push(dir);
  return dir;
}
function own(db: Database.Database) {
  databases.push(db);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expectProductionPolicy(db: Database.Database) {
  expect(db.memory).toBe(false);
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(db.pragma('synchronous', { simple: true })).toBe(1);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
}

const schema = (db: Database.Database) =>
  db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
const versions = (db: Database.Database) =>
  db.prepare('SELECT version FROM schema_version ORDER BY version').all();

it('opens on-disk test databases with the production connection policy', () => {
  const file = path.join(root(), 'state.db');
  const db = own(openTestDiskDatabase(file));
  expectProductionPolicy(db);
  db.exec('CREATE TABLE kept(value TEXT); INSERT INTO kept VALUES (1)');
  db.close();
  expect(own(openTestDiskDatabase(file)).prepare('SELECT value FROM kept').all()).toEqual([
    { value: '1' },
  ]);
});

it('creates historical schemas identical to an uncached on-disk runner replay of the same files', () => {
  const dir = root();
  const legacy = path.join(dir, 'migrations');
  // Reference: the pre-helper fixture shape, copying the selection and replaying it on disk.
  const reference = own(createDatabase(path.join(dir, 'reference.db'), logger));
  const selected = readdirSync(MIGRATIONS_DIR).filter((name) => {
    const version = Number.parseInt(name, 10);
    return name.endsWith('.sql') && version <= 182 && version !== 153;
  });
  mkdirSync(legacy);
  for (const name of selected)
    copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(legacy, name));
  runMigrations(reference, legacy, logger);

  const db = own(
    createHistoricalDiskDatabase(path.join(dir, 'historical.db'), [
      { dir: MIGRATIONS_DIR, through: 182, except: [153] },
    ]),
  );
  expectProductionPolicy(db);
  expect(schema(db)).toEqual(schema(reference));
  expect(versions(db)).toEqual(versions(reference));
  expect(versions(db)).not.toContainEqual({ version: 153 });
  expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('gives every caller a private file and lets the real upgrade run on disk', async () => {
  const dir = root();
  const selection = [{ dir: MIGRATIONS_DIR, through: 139 }];
  const first = own(createHistoricalDiskDatabase(path.join(dir, 'first.db'), selection));
  const second = own(createHistoricalDiskDatabase(path.join(dir, 'second.db'), selection));
  first.exec('CREATE TABLE first_only(value TEXT)');
  expect(
    second.prepare("SELECT 1 FROM sqlite_schema WHERE name='first_only'").get(),
  ).toBeUndefined();
  expect(second.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: 139 });
  await runMigrationsWithBackups(second, MIGRATIONS_DIR, logger);
  const latest = Math.max(
    ...readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => Number.parseInt(name, 10)),
  );
  expect(second.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({
    v: latest,
  });
  expect(first.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: 139 });
});

/**
 * Writable on-disk test databases must use the production policy (see disk-database.ts). These
 * fixtures deliberately keep the bare constructor: offline tools, backup/cutover and migration
 * runner tests whose subject is a non-daemon connection or a legacy rollback-journal file.
 */
const BARE_DISK_CONSTRUCTORS: Record<string, number> = {
  'configuration/configuration-cutover.test.ts': 11,
  'configuration/conversion-cli.test.ts': 2,
  'configuration/conversion-rehearsal.test.ts': 1,
  'db/backup.test.ts': 2,
  'db/cutover-backup.test.ts': 2,
  'db/migrate.test.ts': 6,
  'db/reconcile-native-checkpoint.test.ts': 1,
  // Child-process contract harness with a partial (managed-only) schema; no foreign-key parents.
  'test-utils/managed-contract-bridge.ts': 1,
};

it('keeps writable on-disk test databases on the production connection policy', () => {
  const src = path.resolve(import.meta.dirname, '..');
  const files = (readdirSync(src, { recursive: true }) as string[]).filter(
    (file) =>
      file.endsWith('.test.ts') ||
      (file.startsWith(`test-utils${path.sep}`) && file.endsWith('.ts')),
  );
  const found: Record<string, number> = {};
  for (const file of files) {
    const text = readFileSync(path.join(src, file), 'utf8');
    for (const match of text.matchAll(/new Database\(([^)]*)\)?/g)) {
      const args = match[1] ?? '';
      // In-memory, deserialized-image and read-only connections are not writable disk files.
      if (/':memory:'|Buffer|template|serialize|readonly: true/.test(args)) continue;
      if (/readonly: true/.test(text.slice(match.index, match.index + 200).split('\n')[0] ?? ''))
        continue;
      found[file] = (found[file] ?? 0) + 1;
    }
  }
  expect(found).toEqual(BARE_DISK_CONSTRUCTORS);
});
