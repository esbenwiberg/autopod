import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
