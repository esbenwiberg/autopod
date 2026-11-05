import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDb, createTestDb, insertTestProfile } from './mock-helpers.js';

const databases: Database.Database[] = [];
function own(db: Database.Database) {
  databases.push(db);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  vi.restoreAllMocks();
});

describe('isolated migrated test databases', () => {
  it('matches the complete uncached migration schema, seeded state and connection settings', () => {
    const migrated = own(createMigratedTestDb());
    const copied = own(createTestDb());
    const schema = 'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name';
    expect(copied.prepare(schema).all()).toEqual(migrated.prepare(schema).all());
    const tables = migrated
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const table = `"${name.replaceAll('"', '""')}"`;
      const rows = (db: Database.Database) => db.prepare(`SELECT * FROM ${table}`).all();
      // This singleton's migration timestamp is the only time-dependent seed value.
      const seedRows = (db: Database.Database) =>
        rows(db).map((row) => {
          if (name !== 'configuration_security_policy') return row;
          const { updated_at: _timestamp, ...policy } = row as Record<string, unknown>;
          return policy;
        });
      expect(seedRows(copied), name).toEqual(seedRows(migrated));
    }
    for (const setting of ['foreign_keys', 'journal_mode', 'synchronous', 'user_version'])
      expect(copied.pragma(setting, { simple: true })).toBe(
        migrated.pragma(setting, { simple: true }),
      );
    expect(copied.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(copied.pragma('foreign_key_check')).toEqual([]);
  });

  it('isolates rows, schema changes, transactions, connection pragmas and close operations', () => {
    const first = own(createTestDb());
    const second = own(createTestDb());
    insertTestProfile(first, { name: 'first-only' });
    expect(second.prepare("SELECT 1 FROM profiles WHERE name='first-only'").get()).toBeUndefined();
    first.exec(
      "CREATE TABLE fixture_only(value TEXT); BEGIN; INSERT INTO fixture_only VALUES ('uncommitted')",
    );
    expect(
      second.prepare("SELECT 1 FROM sqlite_schema WHERE name='fixture_only'").get(),
    ).toBeUndefined();
    first.exec('ROLLBACK');
    first.pragma('foreign_keys = OFF');
    expect(second.pragma('foreign_keys', { simple: true })).toBe(1);
    first.close();
    const third = own(createTestDb());
    expect(third.prepare("SELECT 1 FROM profiles WHERE name='first-only'").get()).toBeUndefined();
    expect(
      third.prepare("SELECT 1 FROM sqlite_schema WHERE name='fixture_only'").get(),
    ).toBeUndefined();
    expect(third.pragma('foreign_keys', { simple: true })).toBe(1);
    third.exec(
      'CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TABLE fixture_child(parent_id INTEGER REFERENCES fixture_parent(id))',
    );
    expect(() => third.exec('INSERT INTO fixture_child VALUES (999)')).toThrow('FOREIGN KEY');
    expect(second.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('does not replay migration reads for subsequent isolated fixtures', () => {
    own(createTestDb());
    const read = vi.spyOn(fs, 'readFileSync');
    own(createTestDb());
    own(createTestDb());
    expect(read).not.toHaveBeenCalled();
  });
});
