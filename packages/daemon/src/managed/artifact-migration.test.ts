import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';

it('upgrades legacy rows without changing historical artifacts and reopens idempotently', () => {
  const db = new Database(':memory:');
  const directory = path.resolve(import.meta.dirname, '../db/migrations');
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  expect(new Set(files.map((name) => name.split('_')[0])).size).toBe(files.length);
  runMigrations(db, directory, pino({ level: 'silent' }));
  const version = db.prepare('SELECT max(version) AS version FROM schema_version').get();
  expect(version).toEqual({ version: 153 });
  expect(
    (db.prepare('PRAGMA table_info(pods)').all() as { name: string }[]).some(
      (row) => row.name === 'artifacts_path',
    ),
  ).toBe(true);
  expect(db.prepare('SELECT count(*) AS count FROM artifact_exports').get()).toEqual({ count: 0 });
  runMigrations(db, directory, pino({ level: 'silent' }));
  expect(db.prepare('SELECT max(version) AS version FROM schema_version').get()).toEqual(version);
  const sql = readFileSync(path.join(directory, '142_managed_artifact_exports.sql'), 'utf8');
  expect(sql).not.toMatch(/UPDATE\s+pods|DROP\s+TABLE/i);
  db.close();
});
it('151 through 153 preserve native rows and old managed schema on a real 150 upgrade and replay', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'managed-upgrade-'));
  const db = new Database(':memory:');
  const logger = pino({ level: 'silent' });
  const source = path.resolve(import.meta.dirname, '../db/migrations');
  try {
    for (const name of readdirSync(source).filter(
      (name) => name.endsWith('.sql') && Number(name.split('_')[0]) <= 150,
    ))
      copyFileSync(path.join(source, name), path.join(root, name));
    runMigrations(db, root, logger);
    db.prepare(
      "INSERT INTO profiles(name,repo_url,build_command,start_command) VALUES ('native','fixture','build','start')",
    ).run();
    db.prepare(
      "INSERT INTO pods(id,profile_name,task,model,branch,user_id,status,artifacts_path) VALUES ('native-one','native','preserve','fixture','main','fixture','failed','/historical/artifacts')",
    ).run();
    const native = db.prepare('SELECT * FROM pods').all();
    const profiles = db.prepare('SELECT * FROM profiles').all();
    const tables = db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'managed_%' ORDER BY name",
      )
      .all();
    runMigrations(db, source, logger);
    runMigrations(db, source, logger);
    expect(db.prepare('SELECT * FROM pods').all()).toEqual(native);
    expect(db.prepare('SELECT * FROM profiles').all()).toEqual(profiles);
    expect(
      db
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'managed_%' AND name NOT IN ('managed_provider_requests','managed_github_reads') ORDER BY name",
        )
        .all(),
    ).toEqual(tables);
    expect(db.prepare('SELECT * FROM managed_provider_requests').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM managed_github_reads').all()).toEqual([]);
    expect(db.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
    expect(db.prepare('SELECT max(version) AS version FROM schema_version').get()).toEqual({
      version: 153,
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('152 preserves existing 151 observed and uncertain journals with unknown historical usage', () => {
  const db = new Database(':memory:');
  const source = path.resolve(import.meta.dirname, '../db/migrations');
  try {
    db.exec(
      "CREATE TABLE managed_pods(pod_id TEXT PRIMARY KEY); INSERT INTO managed_pods VALUES ('pod');",
    );
    db.exec(readFileSync(path.join(source, '151_managed_provider_requests.sql'), 'utf8'));
    db.prepare(
      "INSERT INTO managed_provider_requests VALUES ('pod','one','request','transport',1,'observed','\"report\"')",
    ).run();
    db.prepare(
      "INSERT INTO managed_provider_requests VALUES ('pod','two','request2','transport',1,'reserved',NULL)",
    ).run();
    const before = db.prepare('SELECT * FROM managed_provider_requests').all();
    db.exec(readFileSync(path.join(source, '152_managed_request_usage.sql'), 'utf8'));
    expect(
      db
        .prepare(
          'SELECT pod_id,operation_key,request_digest,transport_digest,grant_revision,state,response_json FROM managed_provider_requests',
        )
        .all(),
    ).toEqual(before);
    expect(db.prepare('SELECT actual_tokens FROM managed_provider_requests').all()).toEqual([
      { actual_tokens: null },
      { actual_tokens: null },
    ]);
  } finally {
    db.close();
  }
});
