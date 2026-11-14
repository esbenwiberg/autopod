import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

const migrations = new URL('./migrations', import.meta.url).pathname;
const logger = pino({ level: 'silent' });

it('upgrades an existing infrastructure-recovery v242 database without losing its custody/events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-upgrade-'));
  const oldMigrations = path.join(root, 'v242');
  fs.mkdirSync(oldMigrations);
  for (const name of fs.readdirSync(migrations)) {
    if (name.endsWith('.sql') && Number.parseInt(name, 10) <= 242)
      fs.copyFileSync(path.join(migrations, name), path.join(oldMigrations, name));
  }
  const filename = path.join(root, 'existing.db');
  let db = new Database(filename);
  try {
    runMigrations(db, oldMigrations, logger);
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: 242 });
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='retained_coding_facts'").get(),
    ).toBeUndefined();
    db.prepare('INSERT INTO retained_checkpoint_recoveries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      'infrastructure-original',
      'pod',
      'task',
      1,
      'original-container',
      'docker://original',
      '/original',
      'request-hash',
      '{"type":"human","userId":"owner"}',
      'Preserve original infrastructure evidence',
      JSON.stringify({ continuation: { infrastructure: { version: 1, mode: 'rework' } } }),
      '{"result":null,"infrastructureReports":[{"id":"original-report"}]}',
      '2026-11-01',
    );
    for (const kind of ['stop-dispatched', 'stopped', 'worker', 'candidate'])
      db.prepare('INSERT INTO retained_infrastructure_events VALUES(?,?,?,?)').run(
        'infrastructure-original',
        kind,
        JSON.stringify({ original: kind }),
        '2026-11-01',
      );
    const priorRows = db.prepare('SELECT * FROM retained_checkpoint_recoveries').all();
    const priorEvents = db
      .prepare('SELECT * FROM retained_infrastructure_events ORDER BY kind')
      .all();
    db.close();
    db = new Database(filename);
    runMigrations(db, migrations, logger);
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: 251 });
    expect(db.prepare('SELECT * FROM retained_blocked_repair_handoffs').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM retained_network_releases').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM retained_network_release_outcomes').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM provider_account_health_observations').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM artifact_checks_recoveries').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM artifact_checks_recovery_events').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM recovery_forks').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM recovery_fork_delivery_evidence').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM stalled_worker_recoveries').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM retained_checkpoint_recoveries').all()).toEqual(priorRows);
    expect(db.prepare('SELECT * FROM retained_infrastructure_events ORDER BY kind').all()).toEqual(
      priorEvents,
    );
    expect(db.prepare('SELECT * FROM retained_coding_continuations').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM retained_coding_facts').all()).toEqual([]);
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {
      name: string;
    }[];
    expect(triggers.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'stalled_worker_recovery_immutable',
        'stalled_worker_recovery_no_delete',
        'stalled_worker_new_run_fence',
        'stalled_worker_new_admission_fence',
        'retained_coding_no_update',
        'retained_coding_no_delete',
        'retained_coding_facts_no_update',
        'retained_coding_facts_no_delete',
        'retained_infrastructure_events_no_update',
        'retained_infrastructure_events_no_delete',
      ]),
    );
    // Exercise the upgraded companion's actual append-only protections, not just names.
    db.exec(`INSERT INTO retained_checkpoint_recoveries
      SELECT 'companion-fixture','other-pod',task_id,generation,'other-container',
        resource_key,worktree_path,request_hash,actor,reason,binding,original_evidence,created_at
      FROM retained_checkpoint_recoveries WHERE id='infrastructure-original'`);
    db.prepare('INSERT INTO retained_coding_continuations VALUES(?,?,?,?,?,?,?)').run(
      'companion-fixture',
      'other-pod',
      'hash',
      '{}',
      '{}',
      '{"version":1,"mode":"qualify_then_code_once"}',
      '2026-11-02',
    );
    db.prepare('INSERT INTO retained_coding_facts VALUES(?,?,?,?)').run(
      'companion-fixture',
      'entered',
      '{"processEpoch":"fixture"}',
      '2026-11-02',
    );
    expect(() => db.exec("UPDATE retained_coding_continuations SET request='{}'")).toThrow(
      'immutable',
    );
    expect(() => db.exec('DELETE FROM retained_coding_continuations')).toThrow('cannot be deleted');
    expect(() => db.exec("UPDATE retained_coding_facts SET evidence='{}'")).toThrow('immutable');
    expect(() => db.exec('DELETE FROM retained_coding_facts')).toThrow('cannot be deleted');
    expect(() => db.exec("UPDATE retained_infrastructure_events SET evidence='{}'")).toThrow(
      'immutable',
    );
    expect(() => db.exec('DELETE FROM retained_infrastructure_events')).toThrow(
      'cannot be deleted',
    );
    db.prepare('INSERT INTO retained_blocked_repair_handoffs VALUES(?,?,?,?)').run(
      'infrastructure-original',
      'companion-fixture',
      'a'.repeat(64),
      'now',
    );
    expect(() =>
      db.exec("UPDATE retained_blocked_repair_handoffs SET predecessor_hash='changed'"),
    ).toThrow('immutable');
    expect(() => db.exec('DELETE FROM retained_blocked_repair_handoffs')).toThrow('retained');
    runMigrations(db, migrations, logger);
    expect(db.prepare('SELECT COUNT(*) AS n FROM retained_blocked_repair_handoffs').get()).toEqual({
      n: 1,
    });
    expect(db.prepare('SELECT * FROM retained_infrastructure_events ORDER BY kind').all()).toEqual(
      priorEvents,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM retained_coding_facts').get()).toEqual({ n: 1 });
  } finally {
    if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  // Two full on-disk migration passes can exceed Vitest's 5s default on bounded workers.
}, 30_000);
