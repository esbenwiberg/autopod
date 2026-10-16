import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import {
  databaseIdentity,
  fileChecksum,
  parseBackupReceipt,
  verifyBackupRestore,
} from './backup-verification.js';
import { createDatabase } from './connection.js';
import { runMigrations, runMigrationsWithBackups } from './migrate.js';

const retainedPod = (db: Database.Database) =>
  db
    .prepare(`SELECT id, profile_name, task, task_summary, status, branch,
      worktree_path, recovery_worktree_path, start_commit_sha FROM pods WHERE id='retained'`)
    .get();
const guidance = (db: Database.Database) =>
  db.prepare("SELECT * FROM nudge_messages WHERE pod_id='retained' ORDER BY id").all();
const versions = (db: Database.Database) =>
  db.prepare('SELECT version FROM schema_version ORDER BY version').all();
const schema = (db: Database.Database) =>
  db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
const assertIntegrity = (db: Database.Database) => {
  expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  expect(db.pragma('foreign_key_check')).toEqual([]);
};

// Real disk, WAL, online backups and fsyncs; the deadline is functional, not a benchmark.
it('upgrades schema 182 through its actual historical backup without changing newer original data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autopod-upgrade-roundtrip-'));
  const connections: Database.Database[] = [];
  const track = (db: Database.Database) => {
    connections.push(db);
    return db;
  };
  try {
    const migrations = resolve(import.meta.dirname, 'migrations');
    const historicalMigrations = join(root, 'historical-migrations');
    const originalDirectory = join(root, 'original');
    const restoredDirectory = join(root, 'restored');
    const inspectionDirectory = join(root, 'inspection');
    const backups = join(originalDirectory, 'backups');
    const restoredBackups = join(restoredDirectory, 'backups');
    for (const directory of [historicalMigrations, backups, restoredBackups, inspectionDirectory])
      mkdirSync(directory, { recursive: true });
    const migrationFiles = readdirSync(migrations).filter((name) => name.endsWith('.sql'));
    const latestVersion = Math.max(...migrationFiles.map((name) => Number.parseInt(name, 10)));
    for (const name of migrationFiles) {
      const version = Number.parseInt(name, 10);
      if (version <= 182 && version !== 153)
        copyFileSync(join(migrations, name), join(historicalMigrations, name));
    }

    const originalPath = join(originalDirectory, 'active.db');
    const original = track(createDatabase(originalPath, logger));
    original.pragma('wal_autocheckpoint = 0');
    runMigrations(original, historicalMigrations, logger);
    expect(original.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
      version: 182,
    });
    expect(
      original.prepare('SELECT version FROM schema_version WHERE version=153').get(),
    ).toBeUndefined();
    expect(
      original.prepare("SELECT name FROM sqlite_master WHERE name='managed_github_reads'").get(),
    ).toBeUndefined();
    original.pragma('wal_checkpoint(TRUNCATE)');
    original.transaction(() => {
      insertTestProfile(original);
      original
        .prepare(`INSERT INTO pods
        (id,profile_name,task,status,model,runtime,branch,user_id,task_summary,
         worktree_path,recovery_worktree_path,start_commit_sha)
        VALUES ('retained','test-profile','Keep source and guidance','failed','model','codex',
          'retained-branch','operator','retained summary','/fixture/source','/fixture/recovery',?)`)
        .run('a'.repeat(40));
      original
        .prepare("INSERT INTO nudge_messages(pod_id,message) VALUES ('retained',?)")
        .run('Committed WAL guidance after schema checkpoint');
    })();
    expect(statSync(`${originalPath}-wal`).size).toBeGreaterThan(0);
    const historicalPod = retainedPod(original);
    const historicalGuidance = guidance(original);
    const historicalVersions = versions(original);
    expect(historicalPod).toMatchObject({
      task: 'Keep source and guidance',
      task_summary: 'retained summary',
      branch: 'retained-branch',
      worktree_path: '/fixture/source',
      recovery_worktree_path: '/fixture/recovery',
      start_commit_sha: 'a'.repeat(40),
    });
    expect(historicalGuidance).toHaveLength(1);
    const expectedSourceIdentity = databaseIdentity(originalPath);

    const assertUpgraded = (db: Database.Database) => {
      expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
        version: latestVersion,
      });
      expect(db.prepare('SELECT version FROM schema_version WHERE version=153').get()).toEqual({
        version: 153,
      });
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='managed_github_reads'").get(),
      ).toEqual({ name: 'managed_github_reads' });
      expect(retainedPod(db)).toEqual(historicalPod);
      assertIntegrity(db);
    };
    await runMigrationsWithBackups(original, migrations, logger);
    assertUpgraded(original);
    expect(guidance(original)).toEqual(historicalGuidance);

    const suffixes = [
      'pre-repository-memory-scope',
      'pre-pod-configuration-identity',
      'pre-scheduled-launch-selection',
      'pre-issue-watcher-bindings',
    ];
    const names = readdirSync(backups).sort();
    const snapshots: { file: string; path: string; sha256: string; receiptSha256: string }[] = [];
    expect(names).toHaveLength(suffixes.length * 2);
    for (const suffix of suffixes) {
      const matching = names.filter((name) => name.endsWith(`-${suffix}.db`));
      expect(matching, suffix).toHaveLength(1);
      const file = matching[0];
      if (!file) throw new Error(`Missing historical snapshot for ${suffix}`);
      expect(names).toContain(`${file}.json`);
      const backupPath = join(backups, file);
      const receipt = parseBackupReceipt(readFileSync(`${backupPath}.json`, 'utf8'));
      const sha256 = await fileChecksum(backupPath);
      snapshots.push({
        file,
        path: backupPath,
        sha256,
        receiptSha256: await fileChecksum(`${backupPath}.json`),
      });
      expect(receipt).toMatchObject({
        version: 2,
        file,
        sourceIdentity: expectedSourceIdentity,
        sha256,
      });
      expect(receipt.bytes).toBe(statSync(backupPath).size);
      expect(
        await verifyBackupRestore(backupPath, { expectedSourceIdentity, maxAgeMs: 120_000 }),
      ).toMatchObject({
        sourceIdentity: expectedSourceIdentity,
        watermarkScope: 'all_tables',
        sha256,
      });
      // SQLite can create WAL/SHM sidecars even for a readonly connection. Inspect
      // identical disposable bytes so the historical backup directory stays untouched.
      const inspectionPath = join(inspectionDirectory, file);
      copyFileSync(backupPath, inspectionPath);
      expect(await fileChecksum(inspectionPath)).toBe(sha256);
      const snapshot = track(new Database(inspectionPath, { readonly: true, fileMustExist: true }));
      try {
        expect(versions(snapshot)).toEqual(historicalVersions);
        expect(retainedPod(snapshot)).toEqual(historicalPod);
        expect(guidance(snapshot)).toEqual(historicalGuidance);
        assertIntegrity(snapshot);
      } finally {
        snapshot.close();
      }
    }

    original
      .prepare("INSERT INTO nudge_messages(pod_id,message) VALUES ('retained',?)")
      .run('Newer original guidance must survive restore qualification');
    const newerOriginal = {
      pods: original.prepare('SELECT * FROM pods ORDER BY id').all(),
      guidance: guidance(original),
      schema: schema(original),
      versions: original.prepare('SELECT * FROM schema_version ORDER BY version').all(),
    };
    expect(newerOriginal.guidance).toHaveLength(2);
    const originalVersions = versions(original);
    const selected = snapshots[0];
    if (!selected) throw new Error('Missing verified historical snapshot');
    await verifyBackupRestore(selected.path, { expectedSourceIdentity, maxAgeMs: 120_000 });
    const restoredPath = join(restoredDirectory, 'active.db');
    copyFileSync(selected.path, restoredPath);
    let restored = track(createDatabase(restoredPath, logger));
    expect(databaseIdentity(restoredPath)).not.toBe(expectedSourceIdentity);
    expect(versions(restored)).toEqual(historicalVersions);
    await runMigrationsWithBackups(restored, migrations, logger);
    assertUpgraded(restored);
    expect(guidance(restored)).toEqual(historicalGuidance);
    expect(schema(restored)).toEqual(newerOriginal.schema);
    expect(versions(restored)).toEqual(originalVersions);
    const restoredVersions = restored
      .prepare('SELECT * FROM schema_version ORDER BY version')
      .all();
    const restoredBackupNames = readdirSync(restoredBackups).sort();
    expect(restoredBackupNames).toHaveLength(suffixes.length * 2);
    await runMigrationsWithBackups(restored, migrations, logger);
    expect(restored.prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(
      restoredVersions,
    );
    expect(readdirSync(restoredBackups).sort()).toEqual(restoredBackupNames);
    restored.close();
    restored = track(createDatabase(restoredPath, logger));
    assertUpgraded(restored);
    expect(guidance(restored)).toEqual(historicalGuidance);
    expect(schema(restored)).toEqual(newerOriginal.schema);
    expect(versions(restored)).toEqual(originalVersions);

    expect({
      pods: original.prepare('SELECT * FROM pods ORDER BY id').all(),
      guidance: guidance(original),
      schema: schema(original),
      versions: original.prepare('SELECT * FROM schema_version ORDER BY version').all(),
    }).toEqual(newerOriginal);
    assertIntegrity(original);
    expect(readdirSync(backups).sort()).toEqual(names);
    for (const snapshot of snapshots) {
      expect(await fileChecksum(snapshot.path)).toBe(snapshot.sha256);
      expect(await fileChecksum(`${snapshot.path}.json`)).toBe(snapshot.receiptSha256);
    }
  } finally {
    try {
      for (const connection of connections) if (connection.open) connection.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  expect(existsSync(root)).toBe(false);
}, 60_000);
