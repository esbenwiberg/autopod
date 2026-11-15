import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runMigrationsWithBackups } from '../db/migrate.js';
import {
  createHistoricalDiskDatabase,
  MIGRATIONS_DIR,
  openTestDiskDatabase,
} from '../test-utils/disk-database.js';
import { insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createPodRepository } from './pod-repository.js';

// On-disk upgrade with cutover backups and a reopen; a functional, not a latency, test.
it('upgrades schema 180, blocks old destructive deletion, and retains event/progress rows through reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retained-history-upgrade-'));
  const migrations = MIGRATIONS_DIR;
  let db = createHistoricalDiskDatabase(join(dir, 'state.db'), [{ dir: migrations, through: 180 }]);
  try {
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
    await runMigrationsWithBackups(db, migrations, logger);
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
    db = openTestDiskDatabase(snapshot);
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
}, 30_000);
