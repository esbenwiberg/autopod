import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';

it('upgrades schema 180, blocks old destructive deletion, and retains event/progress rows through reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retained-history-upgrade-'));
  const migrations = resolve(import.meta.dirname, '../db/migrations');
  for (const file of readdirSync(migrations))
    if (Number.parseInt(file, 10) <= 180) copyFileSync(join(migrations, file), join(dir, file));
  let db = new Database(join(dir, 'state.db'));
  try {
    db.pragma('foreign_keys = ON');
    runMigrations(db, dir, logger);
    insertTestProfile(db);
    db.prepare(
      "INSERT INTO pods(id,profile_name,task,status,model,runtime,branch,user_id,max_validation_attempts,skip_validation,output_mode) VALUES ('legacy','test-profile','Retain observations','failed','model','codex','legacy','operator',3,0,'pr')",
    ).run();
    db.prepare(
      "INSERT INTO events(pod_id,type,payload) VALUES ('legacy','pod.status_changed',?)",
    ).run(JSON.stringify({ newStatus: 'failed' }));
    db.prepare(
      "INSERT INTO session_progress_events(id,pod_id,phase,description,current_phase,total_phases) VALUES ('phase','legacy','build','Preserved phase',1,2)",
    ).run();
    const events = db.prepare('SELECT * FROM events').all();
    const progress = db.prepare('SELECT * FROM session_progress_events').all();
    runMigrations(db, migrations, logger);
    expect(db.prepare('SELECT * FROM retained_events').all()).toEqual(events);
    expect(db.prepare('SELECT * FROM retained_session_progress_events').all()).toEqual(progress);
    expect(() =>
      db.transaction(() => {
        db.prepare(
          "INSERT INTO task_history_deletions(pod_id,archived_at) VALUES ('legacy','2026-09-08T00:00:00Z')",
        ).run();
        db.prepare("INSERT INTO task_history_pods SELECT * FROM pods WHERE id='legacy'").run();
        db.prepare("DELETE FROM pods WHERE id='legacy'").run();
      })(),
    ).toThrow('requires retained event history');
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_history_deletions').get()).toEqual({
      count: 0,
    });
    createPodRepository(db).delete('legacy');
    expect(db.prepare('SELECT * FROM retained_events').all()).toEqual(events);
    expect(db.prepare('SELECT * FROM retained_session_progress_events').all()).toEqual(progress);
    const snapshot = join(dir, 'reopened.db');
    writeFileSync(snapshot, db.serialize());
    db.close();
    db = new Database(snapshot);
    expect(db.prepare('SELECT * FROM retained_events').all()).toEqual(events);
    expect(db.prepare('SELECT * FROM retained_session_progress_events').all()).toEqual(progress);
    expect(() => db.prepare("UPDATE task_history_events SET payload='rewritten'").run()).toThrow(
      'immutable',
    );
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
