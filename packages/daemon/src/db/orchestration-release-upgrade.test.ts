import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  createHistoricalDiskDatabase,
  MIGRATIONS_DIR,
  migrationVersions,
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

// Every shipped migration from the orchestration chain (262) onward must be applied, none skipped.
const orchestrationTail = () => migrationVersions().filter((version) => version >= 262);

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
      ).toEqual(orchestrationTail());
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

it('rehearses exactly 276 to 280 on a verified synthetic backup built from the released SQL prefix', async () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const released = files.filter((name) => Number.parseInt(name, 10) <= 276);
  const prefix = released
    .map((name) => `${name}:${sha(readFileSync(path.join(MIGRATIONS_DIR, name)))}\n`)
    .join('');
  // Ordered path/hash manifest from main at 4f72f273, before parent migrations.
  expect(sha(prefix)).toBe('1b76d8266c0f3549e07eaf61f4f12cd157fe381f21949effe7ad004588c74792');
  const root = mkdtempSync(path.join(tmpdir(), 'orch-main-276-'));
  let source: ReturnType<typeof createHistoricalDiskDatabase> | undefined;
  try {
    const exact = path.join(root, 'through-280');
    mkdirSync(exact);
    for (const name of files.filter((name) => Number.parseInt(name, 10) <= 280))
      copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(exact, name));
    const releasedDb = createHistoricalDiskDatabase(path.join(root, 'released.db'), [
      { dir: exact, through: 276 },
    ]);
    source = releasedDb;
    releasedDb.exec(`
      INSERT INTO orchestration_runs(id,repository,policy_digest,accepted_commit,accepted_evidence,worker_request_limit,canceled,operator_owned)
        VALUES('retained','private','fixture-policy','fixture-commit','fixture-evidence',6,1,1);
      INSERT INTO orchestration_checkpoint_custody VALUES('retained','fixture-evidence','{}',x'0102');
      INSERT INTO managed_pods(pod_id,dispatcher_installation_id,dispatcher_attempt_id,managed_start_key,
        execution_spec_digest,profile_snapshot_digest,grant_id,grant_revision,effective_grant_digest,
        request_json,handle_json,created_at) VALUES('retained-worker','fixture-installation','a','k','spec','profile','grant',1,'digest','{}','{}',1);
      INSERT INTO approval_rewrite_abandonments VALUES(
        'fixture-disposition','archived-pod',1,'fixture-binding','fixture-request','fixture-user','synthetic rehearsal','{}','2026-01-01'
      );
      INSERT INTO approval_rewrite_abandonment_events VALUES('fixture-disposition','complete','','2026-01-01');
    `);
    const existing = () =>
      [
        'orchestration_runs',
        'orchestration_checkpoint_custody',
        'orchestration_request_balances',
        'approval_rewrite_abandonments',
        'approval_rewrite_abandonment_events',
      ].map((table) => `SELECT * FROM ${table}`);
    const before = existing().map((sql) => releasedDb.prepare(sql).all());
    const catalog =
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
    type CatalogEntry = { name: string; sql: string | null };
    const definitions = source.prepare(catalog).all() as CatalogEntry[];
    const versionsBefore = source.prepare('SELECT * FROM schema_version ORDER BY version').all();
    expect(versionsBefore.at(-1)).toMatchObject({ version: 276 });
    const backup = await snapshotBeforeCutover(source, source.name, logger, 'synthetic-main-276');
    if (!backup) throw new Error('missing backup');
    const verified = await verifyBackupRestore(backup.path, {
      expectedSourceIdentity: databaseIdentity(source.name),
      maxAgeMs: 60_000,
    });
    const restored = path.join(root, 'scratch.db');
    copyFileSync(backup.path, restored);
    expect(await fileChecksum(restored)).toBe(verified.sha256);
    const db = openTestDiskDatabase(restored);
    try {
      await runMigrationsWithBackups(db, exact, logger);
      expect(
        db
          .prepare(
            "SELECT type, dflt_value FROM pragma_table_info('managed_pods') WHERE name='last_runtime_observation'",
          )
          .get(),
      ).toEqual({ type: 'TEXT', dflt_value: null });
      expect(
        db
          .prepare(
            "SELECT last_runtime_observation, execution_spec_digest FROM managed_pods WHERE pod_id='retained-worker'",
          )
          .get(),
      ).toEqual({ last_runtime_observation: null, execution_spec_digest: 'spec' });
      expect(
        db
          .prepare(
            "SELECT type, dflt_value FROM pragma_table_info('parent_managed_requests') WHERE name='private_scope_json'",
          )
          .get(),
      ).toEqual({ type: 'TEXT', dflt_value: null });
      const previousNames = new Set(definitions.map(({ name }) => name));
      expect(
        (db.prepare(catalog).all() as CatalogEntry[])
          .filter(({ name }) => previousNames.has(name))
          // Migration 277 adds exactly one nullable column to an existing table.
          .map((entry) =>
            entry.name === 'parent_managed_requests'
              ? { ...entry, sql: entry.sql?.replace(', private_scope_json TEXT', '') }
              : entry,
          ),
      ).toEqual(definitions);
      expect(
        db
          .prepare('SELECT version FROM schema_version WHERE version>276 ORDER BY version')
          .pluck()
          .all(),
      ).toEqual([277, 278, 279, 280]);
      expect(
        db.prepare('SELECT * FROM schema_version WHERE version<=276 ORDER BY version').all(),
      ).toEqual(versionsBefore);
      expect(existing().map((sql) => db.prepare(sql).all())).toEqual(before);
      for (const table of [
        'parent_managed_runs',
        'parent_managed_requests',
        'parent_managed_sessions',
        'parent_private_collection_claims',
        'parent_private_candidates',
        'parent_review_approvals',
        'parent_qualification_jobs',
      ])
        expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
      expect(() => db.exec('DELETE FROM approval_rewrite_abandonment_events')).toThrow(
        'rewrite abandonment receipts are immutable',
      );
      assertBackupIntegrity(db);
      const snapshot = db.serialize();
      const schemaVersion = db.pragma('schema_version', { simple: true });
      const diskEntries = readdirSync(root, { recursive: true }).sort();
      await runMigrationsWithBackups(db, exact, logger);
      expect(db.serialize().equals(snapshot)).toBe(true);
      expect(db.pragma('schema_version', { simple: true })).toBe(schemaVersion);
      expect(readdirSync(root, { recursive: true }).sort()).toEqual(diskEntries);
    } finally {
      db.close();
    }
    expect(source.prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(
      versionsBefore,
    );
    expect(existing().map((sql) => releasedDb.prepare(sql).all())).toEqual(before);
    expect(await fileChecksum(backup.path)).toBe(verified.sha256);
  } finally {
    source?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  273, 276,
])('refuses the unpublished parent trial at schema %i before migration', async (version) => {
  const root = mkdtempSync(path.join(tmpdir(), 'orch-unpublished-parent-'));
  try {
    const trial = path.join(root, 'trial-migrations');
    mkdirSync(trial);
    // Recreate the trial's exact SQL prefix, including its overlapping numbers.
    for (const name of readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'))) {
      const n = Number.parseInt(name, 10);
      const legacy = n >= 277 && n <= 280 && n - 4 <= version;
      if (n <= 272 || legacy) {
        const target = legacy ? `${n - 4}${name.slice(3)}` : name;
        copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(trial, target));
      }
    }
    const db = createHistoricalDiskDatabase(path.join(root, 'trial.db'), [
      { dir: trial, through: version },
    ]);
    try {
      expect(db.prepare('SELECT max(version) FROM schema_version').pluck().get()).toBe(version);
      const before = db.serialize();
      await expect(runMigrationsWithBackups(db, MIGRATIONS_DIR, logger)).rejects.toThrow(
        'Unpublished or mixed parent migration lineage',
      );
      expect(db.serialize().equals(before)).toBe(true);
    } finally {
      db.close();
    }
  } finally {
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
    ).toEqual(orchestrationTail());
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
