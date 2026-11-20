import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  createHistoricalDiskDatabase,
  MIGRATIONS_DIR,
  openTestDiskDatabase,
} from '../test-utils/disk-database.js';
import { logger } from '../test-utils/mock-helpers.js';
import {
  assertBackupIntegrity,
  databaseIdentity,
  fileChecksum,
  verifyBackupRestore,
} from './backup-verification.js';
import { snapshotBeforeCutover } from './cutover-backup.js';
import { runMigrationsWithBackups } from './migrate.js';

it.each([
  255, 256,
])('rehearses the released %i upgrade on a restored online backup, never on the source or snapshot', async (release) => {
  const root = mkdtempSync(path.join(tmpdir(), 'orch-release-'));
  mkdirSync(path.join(root, 'backups'));
  const source = createHistoricalDiskDatabase(path.join(root, 'release.db'), [
    { dir: MIGRATIONS_DIR, through: release },
  ]);
  try {
    source.exec(`INSERT INTO validation_phase_timings VALUES('timing','[123,456]');
 INSERT INTO managed_pods(pod_id,dispatcher_installation_id,dispatcher_attempt_id,managed_start_key,execution_spec_digest,profile_snapshot_digest,grant_id,grant_revision,effective_grant_digest,request_json,handle_json,created_at) VALUES('unresolved','installation','a','k','spec','profile','grant',1,'digest','{}','{}',1)`);
    if (release === 256)
      source
        .prepare("INSERT INTO fresh_handoff_preparations VALUES('p',1,'digest','{}',NULL)")
        .run();
    const prior = source.prepare('SELECT * FROM schema_version ORDER BY version').all();
    const backup = await snapshotBeforeCutover(
      source,
      source.name,
      logger,
      `synthetic-release-${release}`,
    );
    if (!backup) throw new Error('missing backup');
    const verified = await verifyBackupRestore(backup.path, {
      expectedSourceIdentity: databaseIdentity(source.name),
      maxAgeMs: 60000,
    });
    const restored = path.join(root, 'rehearsal.db');
    copyFileSync(backup.path, restored);
    expect(await fileChecksum(restored)).toBe(verified.sha256);
    let db = openTestDiskDatabase(restored);
    try {
      await runMigrationsWithBackups(db, MIGRATIONS_DIR, logger);
      expect(
        db
          .prepare('SELECT version FROM schema_version WHERE version>=262 ORDER BY version')
          .pluck()
          .all(),
      ).toEqual([262, 263, 264, 265, 266, 267, 268, 269, 270, 271]);
      expect(
        db.prepare('SELECT * FROM schema_version WHERE version<=? ORDER BY version').all(release),
      ).toEqual(prior);
      if (release === 256) {
        expect(
          db.prepare('SELECT request_hash FROM fresh_handoff_preparations').pluck().get(),
        ).toBe('digest');
        expect(() => db.exec('DELETE FROM fresh_handoff_preparations')).toThrow('retained');
      }
      expect(db.prepare('SELECT durations_ms FROM validation_phase_timings').pluck().get()).toBe(
        '[123,456]',
      );
      expect(
        db
          .prepare(
            'SELECT allocation_attempted,runtime_ref,observed_exit FROM managed_pods WHERE pod_id=?',
          )
          .raw()
          .get('unresolved'),
      ).toEqual([1, null, 0]);
      expect(db.prepare('SELECT * FROM orchestration_unknown_outcomes').all()).toEqual([]);
      db.exec(
        `INSERT INTO orchestration_runs(id,repository,policy_digest,accepted_commit,worker_request_limit) VALUES('r','fixture','test','sha',18);INSERT INTO orchestration_result_waits VALUES('r','@kickoff',0,1,0);INSERT INTO orchestration_controller_turns(run_id,wait_key,wake_digest,checkpoint_json) VALUES('r','@kickoff','uncertain','{}')`,
      );
      db.close();
      db = openTestDiskDatabase(restored);
      await runMigrationsWithBackups(db, MIGRATIONS_DIR, logger);
      expect(db.prepare('SELECT remaining FROM orchestration_request_balances').pluck().get()).toBe(
        17,
      );
      expect(db.prepare('SELECT kind FROM orchestration_unknown_outcomes').pluck().all()).toEqual([
        'controller',
      ]);
      assertBackupIntegrity(db);
    } finally {
      db.close();
    }
    expect(source.prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(prior);
    expect(await fileChecksum(backup.path)).toBe(verified.sha256);
  } finally {
    source.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('refuses a populated pre-ownership database even when no custody bytes remain', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pre-ownership-'));
  const db = createHistoricalDiskDatabase(path.join(root, 'partial.db'), [
    { dir: MIGRATIONS_DIR, through: 268 },
  ]);
  try {
    db.prepare(
      'INSERT INTO orchestration_runs(id,repository,policy_digest,accepted_commit,worker_request_limit) VALUES(?,?,?,?,?)',
    ).run('run', 'repo', 'policy', 'source', 6);
    const before = db.serialize();
    await expect(runMigrationsWithBackups(db, MIGRATIONS_DIR, logger)).rejects.toThrow(
      'ownership requires explicit reconciliation',
    );
    expect(db.serialize().equals(before)).toBe(true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('resumes a valid partially applied orchestration prefix', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'orch-prefix-'));
  const db = createHistoricalDiskDatabase(path.join(root, 'partial.db'), [
    { dir: MIGRATIONS_DIR, through: 264 },
  ]);
  try {
    await runMigrationsWithBackups(db, MIGRATIONS_DIR, logger);
    expect(
      db
        .prepare('SELECT version FROM schema_version WHERE version>=262 ORDER BY version')
        .pluck()
        .all(),
    ).toEqual([262, 263, 264, 265, 266, 267, 268, 269, 270, 271]);
    assertBackupIntegrity(db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  'DELETE FROM schema_version WHERE version=262; DROP TABLE orchestration_runs',
  'DELETE FROM schema_version WHERE version=263',
  'DROP TABLE fresh_handoff_preparations',
  'DELETE FROM schema_version WHERE version=256',
  'DROP TABLE orchestration_runs',
])('rejects a high version that masks missing orchestration history or its root table: %s', async (damage) => {
  const root = mkdtempSync(path.join(tmpdir(), 'orch-incomplete-'));
  const db = createHistoricalDiskDatabase(path.join(root, 'damaged.db'), [
    { dir: MIGRATIONS_DIR, through: 268 },
  ]);
  try {
    db.exec(damage);
    const before = db.serialize();
    await expect(runMigrationsWithBackups(db, MIGRATIONS_DIR, logger)).rejects.toThrow(
      'orchestration migration lineage',
    );
    expect(db.serialize().equals(before)).toBe(true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  255,
  261,
  'mixed',
] as const)('retains an unpublished or mixed spike database unchanged: %s', async (version) => {
  const root = mkdtempSync(path.join(tmpdir(), 'orch-spike-'));
  const db = createHistoricalDiskDatabase(path.join(root, 'spike.db'), [
    { dir: MIGRATIONS_DIR, through: 254 },
  ]);
  try {
    // The SQL payloads are unchanged. Recreate the previous, unpublished numbering.
    for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
      const canonical = Number.parseInt(file, 10),
        legacy = canonical - 7;
      if (canonical < 262 || canonical > 268 || legacy > (version === 'mixed' ? 261 : version))
        continue;
      db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO schema_version(version) VALUES(?)').run(legacy);
    }
    db.exec(
      "INSERT INTO orchestration_runs(id,repository,policy_digest,accepted_commit,worker_request_limit) VALUES('retained','private','policy','unpublished',18)",
    );
    if (version === 'mixed')
      db.exec(readFileSync(path.join(MIGRATIONS_DIR, '255_validation_phase_timings.sql'), 'utf8'));
    const before = db.serialize();
    await expect(runMigrationsWithBackups(db, MIGRATIONS_DIR, logger)).rejects.toThrow(
      'Unpublished or mixed orchestration migration lineage',
    );
    expect(db.serialize().equals(before)).toBe(true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
