import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logger } from '../test-utils/mock-helpers.js';
import { runMigrations } from './migrate.js';

const migrations = new URL('./migrations/', import.meta.url).pathname;
const repair = '237_rewrite_repair_retry_binding.sql';
const finalization = '241_retained_finalization.sql';

describe('ordered recovery/finalization production migration', () => {
  let db: Database.Database;
  let directory: string;
  const version = () =>
    (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number })
      .version;
  const add = (file: string) =>
    fs.copyFileSync(path.join(migrations, file), path.join(directory, file));
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'finalization-upgrade-'));
    for (const file of fs.readdirSync(migrations)) {
      if (file.endsWith('.sql') && Number.parseInt(file, 10) <= 236) add(file);
    }
    runMigrations(db, directory, logger);
    expect(version()).toBe(236);
    db.exec(`INSERT INTO profiles(name,repo_url,build_command,start_command)
      VALUES ('retained','https://example.invalid/repo','','');
      INSERT INTO pods(id,profile_name,task,status,model,runtime,branch,user_id,execution_target,container_id,worktree_path,last_validation_result)
      VALUES ('retained','retained','Retain uncertain original work','review_required','model','codex','retained','human','sandbox','original-sandbox','/retained/source','{"overall":"fail","unknownExecution":true}');`);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('applies 237 before 241, preserves old evidence and remains idempotent', () => {
    const pod = db.prepare('SELECT * FROM pods WHERE id=?').get('retained');
    add(repair);
    add(finalization);
    runMigrations(db, directory, logger);
    expect(version()).toBe(241);
    expect(db.prepare('SELECT * FROM pods WHERE id=?').get('retained')).toEqual(pod);
    expect(db.prepare('SELECT rewrite_repair FROM task_retry_authorizations').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM retained_finalizations').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM retained_finalization_resources').all()).toEqual([]);
    runMigrations(db, directory, logger);
    expect(version()).toBe(241);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('refuses a release missing 237 without advancing the version or losing evidence', () => {
    const pod = db.prepare('SELECT * FROM pods WHERE id=?').get('retained');
    add(finalization);
    expect(() => runMigrations(db, directory, logger)).toThrow(/rewrite_repair/);
    expect(version()).toBe(236);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='retained_finalizations'").get(),
    ).toBeUndefined();
    expect(db.prepare('SELECT * FROM pods WHERE id=?').get('retained')).toEqual(pod);
    add(repair);
    runMigrations(db, directory, logger);
    expect(version()).toBe(241);
    expect(db.prepare('SELECT * FROM pods WHERE id=?').get('retained')).toEqual(pod);
  });

  it('upgrades current main through 240 without losing attachment or pod evidence', () => {
    for (const file of fs.readdirSync(migrations)) {
      const number = Number.parseInt(file, 10);
      if (file.endsWith('.sql') && number >= 237 && number <= 240) add(file);
    }
    runMigrations(db, directory, logger);
    expect(version()).toBe(240);
    db.exec(`INSERT INTO input_bundles(id,owner_id,request_key,digest,manifest,byte_length,status,created_at)
      VALUES ('bundle','human','upload','digest','{}',3,'sealed','2026-11-05');
      INSERT INTO input_bundle_files VALUES ('bundle',0,X'0001FF');
      INSERT INTO pod_input_bundles VALUES ('retained','bundle');`);
    const pod = db.prepare('SELECT * FROM pods WHERE id=?').get('retained');
    const tables = ['input_bundles', 'input_bundle_files', 'pod_input_bundles'];
    const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    add(finalization);
    runMigrations(db, directory, logger);
    expect(version()).toBe(241);
    expect(db.prepare('SELECT * FROM pods WHERE id=?').get('retained')).toEqual(pod);
    expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(db.prepare('SELECT * FROM retained_finalizations').all()).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
