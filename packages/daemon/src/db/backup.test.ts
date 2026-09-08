import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createPodRepository } from '../pods/pod-repository.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { databaseWatermark, verifyBackupRestore } from './backup-verification.js';
import { createDbBackupManager } from './backup.js';

const logger = pino({ level: 'silent' });
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'autopod-backup-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'active.db');
  const db = new Database(dbPath);
  cleanups.push(() => db.close());
  db.pragma('journal_mode=WAL');
  db.exec(
    "CREATE TABLE pods (id TEXT PRIMARY KEY, updated_at TEXT); INSERT INTO pods VALUES ('live', '2026-09-07T10:00:00Z')",
  );
  return { dir, dbPath, db };
}
describe('active database backup provenance', () => {
  it('includes actual validation, escalation and task execution tables in backup scope receipts', () => {
    const db = createTestDb();
    try {
      const watermark = databaseWatermark(db);
      for (const table of [
        'validations',
        'escalations',
        'logical_tasks',
        'task_executions',
        'task_agent_runs',
        'pod_finalizations',
        'completion_decisions',
      ])
        expect(watermark[table], table).toMatchObject({ rows: 0 });
    } finally {
      db.close();
    }
  });

  it('restores durable task runs from a full current schema without replacing newer active runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopod-full-backup-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const source = createTestDb();
    insertTestProfile(source);
    source
      .prepare(`INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id)
      VALUES ('root', 'test-profile', 'work', 'running', 'model', 'codex', 'branch', 'user')`)
      .run();
    const initial = createPodRepository(source);
    initial.taskExecutions?.register('root');
    const initialRun = initial.taskExecutions?.beginRun('root', 1, 1, {
      runtime: 'codex',
      model: 'model',
      providerAccountId: null,
    });
    const dbPath = join(dir, 'active.db');
    writeFileSync(dbPath, source.serialize());
    source.close();
    const active = new Database(dbPath);
    cleanups.push(() => active.close());
    const manager = createDbBackupManager(active, dbPath, logger);
    await manager.runOnce();
    const receipt = manager.getStatus().latest;
    if (!receipt) throw new Error('Expected full-schema backup');
    if (!initialRun) throw new Error('Missing initial run');
    const liveLedger = createPodRepository(active).taskExecutions;
    liveLedger?.finishRun(initialRun, 'completed', null);
    liveLedger?.beginRun('root', 1, 2, {
      runtime: 'codex',
      model: 'model',
      providerAccountId: null,
    });
    const verified = await verifyBackupRestore(join(dir, 'backups', receipt.file), {
      expectedSourceIdentity: manager.getStatus().sourceIdentity,
      maxAgeMs: 60_000,
    });
    expect(verified.watermarkScope).toBe('all_tables');
    expect(verified.watermark.task_agent_runs?.rows).toBe(1);
    expect(verified.watermark.validations?.rows).toBe(0);
    expect(verified.watermark.escalations?.rows).toBe(0);
    expect(active.prepare('SELECT COUNT(*) AS n FROM task_agent_runs').get()).toEqual({ n: 2 });
  });

  it('rejects a configured backup path for a different open database', () => {
    const { dir, db } = fixture();
    expect(() => createDbBackupManager(db, join(dir, 'stale.db'), logger)).toThrow(
      /active database/,
    );
  });
  it('backs up committed WAL data and reports freshness across manager restart', async () => {
    const { dbPath, db } = fixture();
    let now = Date.parse('2026-09-07T11:00:00Z');
    const manager = createDbBackupManager(db, dbPath, logger, { now: () => now, intervalMs: 1000 });
    expect(manager.getStatus().state).toBe('missing');
    await manager.runOnce();
    expect(manager.getStatus()).toMatchObject({ state: 'fresh', sourceMatches: true });
    const restarted = createDbBackupManager(db, dbPath, logger, {
      now: () => now,
      intervalMs: 1000,
    });
    expect(restarted.getStatus().state).toBe('fresh');
    now += 3000;
    expect(restarted.getStatus().state).toBe('stale');
    const receipt = manager.getStatus().latest;
    expect(receipt?.watermark.pods).toEqual({ rows: 1, latestUpdatedAt: '2026-09-07T10:00:00Z' });
  });
  it('refuses backup on insufficient headroom and retains the last successful backup', async () => {
    const { dbPath, db } = fixture();
    let free = 1024 ** 3;
    const manager = createDbBackupManager(db, dbPath, logger, { availableBytes: () => free });
    await manager.runOnce();
    const last = manager.getStatus().latest;
    free = 1;
    await manager.runOnce();
    expect(manager.getStatus()).toMatchObject({ state: 'low_headroom', latest: last });
  });
  it('prunes only finalized backups belonging to this database', async () => {
    const { dir, dbPath, db } = fixture();
    let now = 1000;
    const manager = createDbBackupManager(db, dbPath, logger, { now: () => now, retain: 1 });
    await manager.runOnce();
    const unrelated = join(dir, 'backups', '1700000000000.db');
    writeFileSync(unrelated, 'other database backup');
    now += 1000;
    await manager.runOnce();
    expect(readdirSync(join(dir, 'backups')).filter((file) => file.endsWith('.db'))).toHaveLength(
      2,
    );
  });
  it('restores a verified snapshot in isolation while preserving newer active rows', async () => {
    const { dir, dbPath, db } = fixture();
    const manager = createDbBackupManager(db, dbPath, logger);
    await manager.runOnce();
    const receipt = manager.getStatus().latest;
    if (!receipt) throw new Error('Expected finalized backup');
    db.exec("INSERT INTO pods VALUES ('newer', '2026-09-07T12:00:00Z')");
    const backupPath = join(dir, 'backups', receipt.file);
    const verified = await verifyBackupRestore(backupPath, {
      expectedSourceIdentity: manager.getStatus().sourceIdentity,
      maxAgeMs: 60_000,
    });
    expect(verified.watermark.pods?.rows).toBe(1);
    const cliOutput = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../dist/db/verify-backup-cli.js', import.meta.url)),
        '--backup',
        backupPath,
        '--database',
        dbPath,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(cliOutput)).toMatchObject({
      status: 'verified',
      sourceIdentity: receipt.sourceIdentity,
    });

    expect(db.prepare('SELECT COUNT(*) AS count FROM pods').get()).toEqual({ count: 2 });
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='autopod_restore_write_probe'").get(),
    ).toBeUndefined();
    await expect(
      verifyBackupRestore(backupPath, { expectedSourceIdentity: 'wrong-db', maxAgeMs: 60_000 }),
    ).rejects.toThrow('intended active database');
    await expect(
      verifyBackupRestore(backupPath, {
        expectedSourceIdentity: receipt.sourceIdentity,
        maxAgeMs: 1,
        now: Date.now() + 1000,
      }),
    ).rejects.toThrow('freshness');
    writeFileSync(backupPath, 'corrupted snapshot');
    await expect(
      verifyBackupRestore(backupPath, {
        expectedSourceIdentity: receipt.sourceIdentity,
        maxAgeMs: 60_000,
      }),
    ).rejects.toThrow('checksum');
  });
});
