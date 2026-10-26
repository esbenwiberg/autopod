import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

it('adds feed entities while preserving populated configuration revisions and reference foreign keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-migration-'));
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE pods (id TEXT PRIMARY KEY);');
    db.exec(
      readFileSync(
        new URL('./migrations/186_composable_configuration.sql', import.meta.url),
        'utf8',
      ),
    );
    db.exec(`
      CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO schema_version(version) VALUES(212);
      INSERT INTO configuration_entities VALUES('env','environment','Environment',1,0,'now','now');
      INSERT INTO configuration_entities VALUES('profile','profile','Profile',1,0,'now','now');
      INSERT INTO configuration_revisions VALUES('env',1,'Environment','{}','now');
      INSERT INTO configuration_revisions VALUES('profile',1,'Profile','{}','now');
      INSERT INTO configuration_references VALUES('profile','env');
    `);
    const before = db.prepare('SELECT * FROM configuration_entities ORDER BY id').all();
    copyFileSync(
      new URL('./migrations/213_package_feeds.sql', import.meta.url),
      join(dir, '213_package_feeds.sql'),
    );
    runMigrations(db, dir, pino({ level: 'silent' }));
    expect(db.prepare('SELECT * FROM configuration_entities ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM configuration_references').all()).toEqual([
      { source_id: 'profile', target_id: 'env' },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM configuration_revisions').get()).toEqual({ n: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.exec(
      "INSERT INTO configuration_entities VALUES('feed','packageFeed','Feed',1,0,'now','now')",
    );
    expect(() => db.exec("DELETE FROM configuration_entities WHERE id='env'")).toThrow();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
