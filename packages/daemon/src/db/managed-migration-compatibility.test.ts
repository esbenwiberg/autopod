import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { runMigrations } from './migrate.js';

it.each([150, 152])(
  'upgrades managed schema %s without skipping native reliability tables or changing managed data',
  (baseline) => {
    const root = mkdtempSync(join(tmpdir(), 'managed-schema-upgrade-'));
    const migrations = resolve(import.meta.dirname, 'migrations');
    const managed = resolve(import.meta.dirname, 'fixtures/managed-migrations');
    for (const file of readdirSync(migrations))
      if (Number.parseInt(file, 10) <= 141) copyFileSync(join(migrations, file), join(root, file));
    for (const file of readdirSync(managed)) {
      if (Number.parseInt(file, 10) <= baseline)
        copyFileSync(join(managed, file), join(root, file));
    }
    const db = new Database(join(root, 'existing.db'));
    db.pragma('foreign_keys=ON');
    try {
      runMigrations(db, root, logger);
      expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
        version: baseline,
      });
      insertTestProfile(db);
      db.exec(`INSERT INTO pods(id,profile_name,task,status,model,runtime,branch,user_id,task_summary)
      VALUES ('legacy','test-profile','Preserve native work','failed','model','codex','branch','operator','legacy-malformed');
      INSERT INTO managed_workspaces VALUES ('managed','repository','spec','base','/fixture/preserved','ready');
      INSERT INTO managed_pods(pod_id,dispatcher_installation_id,dispatcher_attempt_id,managed_start_key,execution_spec_digest,profile_snapshot_digest,grant_id,grant_revision,effective_grant_digest,request_json,handle_json,created_at)
      VALUES ('managed','installation','attempt','key','spec','profile','grant',1,'grant-digest','{}','{}',1);
      INSERT INTO managed_source_candidates VALUES ('managed','{"candidate":"preserve"}',X'010203');`);
      if (baseline === 152)
        db.exec(`INSERT INTO managed_provider_requests
      (pod_id,operation_key,request_digest,transport_digest,grant_revision,state,response_json,actual_tokens)
      VALUES ('managed','unknown','digest','transport',1,'reserved',NULL,NULL),
      ('managed','measured-zero','digest2','transport',1,'observed','{"preserve":true}',0);`);
      const requests =
        baseline === 152
          ? db.prepare('SELECT * FROM managed_provider_requests ORDER BY operation_key').all()
          : [];
      const before = db.prepare('SELECT * FROM managed_workspaces').all();
      const source = db.prepare('SELECT * FROM managed_source_candidates').all();
      runMigrations(db, migrations, logger);
      for (const file of readdirSync(managed))
        expect(readFileSync(join(migrations, file))).toEqual(readFileSync(join(managed, file)));
      if (baseline === 152)
        expect(
          db.prepare('SELECT * FROM managed_provider_requests ORDER BY operation_key').all(),
        ).toEqual(requests);
      for (const table of [
        'pod_finalizations',
        'logical_tasks',
        'validation_phase_evidence',
        'delivery_intents',
        'source_publication_intents',
        'source_publication_receipts',
        'merge_intents',
        'merge_attempts',
        'merge_observations',
        'merge_disposition_observations',
        'merge_status_observations',
        'scheduled_scan_reports',
        'task_retry_attempts',
        'execution_dispatch_bindings',
        'execution_provenance',
      ])
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
        ).toEqual({ name: table });
      expect(db.prepare('SELECT * FROM managed_workspaces').all()).toEqual(before);
      expect(db.prepare('SELECT * FROM managed_source_candidates').all()).toEqual(source);
      expect(db.prepare("SELECT task_summary FROM pods WHERE id='legacy'").get()).toEqual({
        task_summary: 'legacy-malformed',
      });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('refuses an unpublished native checkpoint lineage before changing any migration records or retained rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-lineage-'));
  const migrations = resolve(import.meta.dirname, 'migrations');
  const historical = resolve(import.meta.dirname, 'fixtures/native-reliability-151-163');
  for (const file of readdirSync(migrations))
    if (Number.parseInt(file, 10) <= 150) copyFileSync(join(migrations, file), join(root, file));
  for (const file of readdirSync(historical))
    copyFileSync(join(historical, file), join(root, file));
  const db = new Database(join(root, 'checkpoint.db'));
  try {
    runMigrations(db, root, logger);
    insertTestProfile(db);
    db.exec(
      "INSERT INTO pods(id,profile_name,task,status,model,runtime,branch,user_id,task_summary) VALUES ('retained','test-profile','Keep local work','failed','model','codex','branch','operator','retained summary')",
    );
    const versions = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    const rows = db.prepare('SELECT * FROM pods').all();
    const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
    expect(() => runMigrations(db, migrations, logger)).toThrow(
      'Unpublished native migration lineage',
    );
    expect(db.prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(versions);
    expect(db.prepare('SELECT * FROM pods').all()).toEqual(rows);
    expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(
      schema,
    );
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
