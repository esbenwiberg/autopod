import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migrate.js';

const logger = pino({ level: 'silent' });

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

describe('runMigrations — @allow-duplicate-columns', () => {
  let migrationsDir: string;

  beforeEach(() => {
    migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
    fs.writeFileSync(
      path.join(migrationsDir, '001_init.sql'),
      'CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT);',
    );
  });

  afterEach(() => {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  });

  it('applies missing ADD COLUMN when previous migration partially applied', () => {
    // Simulate the stuck-DB state: schema_version at 2, but `colB` never got added.
    const db = new Database(':memory:');
    runMigrations(db, migrationsDir, logger);
    db.exec('ALTER TABLE widgets ADD COLUMN colA TEXT');
    db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();

    fs.writeFileSync(
      path.join(migrationsDir, '003_repair.sql'),
      `-- @allow-duplicate-columns
ALTER TABLE widgets ADD COLUMN colA TEXT;
ALTER TABLE widgets ADD COLUMN colB TEXT;`,
    );

    runMigrations(db, migrationsDir, logger);

    expect(hasColumn(db, 'widgets', 'colA')).toBe(true);
    expect(hasColumn(db, 'widgets', 'colB')).toBe(true);
    const ver = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(ver.v).toBe(3);
  });

  it('is a no-op on a fresh DB where all columns already exist', () => {
    const db = new Database(':memory:');
    fs.writeFileSync(
      path.join(migrationsDir, '002_add_cols.sql'),
      `ALTER TABLE widgets ADD COLUMN colA TEXT;
ALTER TABLE widgets ADD COLUMN colB TEXT;`,
    );
    fs.writeFileSync(
      path.join(migrationsDir, '003_repair.sql'),
      `-- @allow-duplicate-columns
ALTER TABLE widgets ADD COLUMN colA TEXT;
ALTER TABLE widgets ADD COLUMN colB TEXT;`,
    );

    expect(() => runMigrations(db, migrationsDir, logger)).not.toThrow();
    expect(hasColumn(db, 'widgets', 'colA')).toBe(true);
    expect(hasColumn(db, 'widgets', 'colB')).toBe(true);
  });

  it('still surfaces non-duplicate-column errors', () => {
    const db = new Database(':memory:');
    fs.writeFileSync(
      path.join(migrationsDir, '002_bad.sql'),
      `-- @allow-duplicate-columns
ALTER TABLE does_not_exist ADD COLUMN foo TEXT;`,
    );
    expect(() => runMigrations(db, migrationsDir, logger)).toThrow(/no such table/);
  });

  it('without the marker, duplicate-column errors are not swallowed', () => {
    const db = new Database(':memory:');
    runMigrations(db, migrationsDir, logger);
    db.exec('ALTER TABLE widgets ADD COLUMN colA TEXT');
    db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();

    fs.writeFileSync(
      path.join(migrationsDir, '003_no_marker.sql'),
      'ALTER TABLE widgets ADD COLUMN colA TEXT;',
    );
    expect(() => runMigrations(db, migrationsDir, logger)).toThrow(/duplicate column/);
  });
});

// ── Migration 091 — drop screenshot blobs ────────────────────────────────────

/** The SQL for migration 091 — located in the real migrations directory. */
const MIGRATION_091_PATH = new URL(
  '../../src/db/migrations/091_drop_screenshot_blobs.sql',
  import.meta.url,
);
const MIGRATION_091_SQL = fs.readFileSync(MIGRATION_091_PATH, 'utf-8');

/** Build a minimal DB that looks like "post-090, pre-091": validations table with
 *  legacy `screenshots` column and `result` JSON containing embedded base64 fields. */
function buildLegacyDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS validations (
      id TEXT PRIMARY KEY,
      pod_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      result TEXT,
      screenshots TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Mark schema_version at 90 so only 091 is pending
  db.prepare('INSERT INTO schema_version (version) VALUES (90)').run();

  // Insert a row with legacy base64 fields embedded in result JSON
  const legacyResult = JSON.stringify({
    smoke: {
      pages: [
        { path: '/', screenshotBase64: 'abc123base64==', passed: true },
        { path: '/about', screenshotBase64: 'def456base64==', passed: true },
      ],
    },
    acValidation: {
      checks: [
        { criterion: 'Has title', screenshot: 'ghiScreenshotBase64==', passed: true },
      ],
    },
    taskReview: {
      screenshots: ['img1base64==', 'img2base64=='],
      passed: true,
    },
  });
  db.prepare(
    `INSERT INTO validations (id, pod_id, attempt, result, screenshots) VALUES (?, ?, ?, ?, ?)`,
  ).run('val-1', 'pod-1', 1, legacyResult, JSON.stringify(['screenshotBlob==']));
}

describe('runMigrations — migration 091 (drop screenshot blobs)', () => {
  let tmpDir: string;
  let migrationsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-091-test-'));
    migrationsDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsDir);
    fs.writeFileSync(path.join(migrationsDir, '091_drop_screenshot_blobs.sql'), MIGRATION_091_SQL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('strips base64 fields from result JSON and drops screenshots column', () => {
    const db = new Database(':memory:');
    buildLegacyDb(db);

    runMigrations(db, migrationsDir, logger); // :memory: → no snapshot

    // Column is gone
    expect(hasColumn(db, 'validations', 'screenshots')).toBe(false);

    // result JSON no longer has base64 fields
    const row = db.prepare('SELECT result FROM validations WHERE id = ?').get('val-1') as {
      result: string;
    };
    const result = JSON.parse(row.result) as {
      smoke: { pages: Array<{ screenshotBase64?: string }> };
      acValidation: { checks: Array<{ screenshot?: string }> };
      taskReview: { screenshots?: unknown[] };
    };

    // smoke pages — screenshotBase64 removed
    expect(result.smoke.pages[0]?.screenshotBase64).toBeUndefined();
    expect(result.smoke.pages[1]?.screenshotBase64).toBeUndefined();

    // AC checks — screenshot removed
    expect(result.acValidation.checks[0]?.screenshot).toBeUndefined();

    // taskReview.screenshots — set to empty array
    expect(result.taskReview.screenshots).toEqual([]);
  });

  it('creates a snapshot file before applying 091 for a real DB path', () => {
    const dbPath = path.join(tmpDir, 'autopod.db');
    const backupsDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(backupsDir);

    // Open a real file-based DB and populate it
    const db = new Database(dbPath);
    buildLegacyDb(db);
    db.close();

    // Reopen (migrate.ts doesn't close it; we need to pass an open handle + dbPath)
    const db2 = new Database(dbPath);
    runMigrations(db2, migrationsDir, logger, dbPath);
    db2.close();

    // A snapshot file should exist in the backups dir
    const backupFiles = fs.readdirSync(backupsDir).filter((f) => f.endsWith('-pre-screenshot-cutover.db'));
    expect(backupFiles).toHaveLength(1);
  });

  it('skips the snapshot when dbPath is :memory:', () => {
    const copyFileSyncSpy = vi.spyOn(fs, 'copyFileSync');

    const db = new Database(':memory:');
    buildLegacyDb(db);
    runMigrations(db, migrationsDir, logger, ':memory:');

    // copyFileSync should never have been called
    expect(copyFileSyncSpy).not.toHaveBeenCalled();
    // Migration still applied
    expect(hasColumn(db, 'validations', 'screenshots')).toBe(false);
  });

  it('does NOT apply migration when snapshot fails (fail-closed)', () => {
    const dbPath = path.join(tmpDir, 'autopod.db');
    const db = new Database(dbPath);
    buildLegacyDb(db);

    // Make copyFileSync throw so the snapshot fails
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => runMigrations(db, migrationsDir, logger, dbPath)).toThrow('disk full');

    // Column must still be present — migration was not applied
    expect(hasColumn(db, 'validations', 'screenshots')).toBe(true);

    db.close();
  });
});
