import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import {
  databaseIdentity,
  parseBackupReceipt,
  verifyBackupRestore,
} from './backup-verification.js';
import { runMigrations, runMigrationsWithBackups } from './migrate.js';

const logger = pino({ level: 'silent' });
afterEach(() => vi.restoreAllMocks());
async function fixture(
  run: (f: {
    root: string;
    db: Database.Database;
    dbPath: string;
    migrations: string;
    backups: string;
  }) => Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-online-'));
  const dbPath = path.join(root, 'active.db');
  const db = new Database(dbPath);
  const migrations = path.join(root, 'migrations');
  const backups = path.join(root, 'backups');
  fs.mkdirSync(migrations);
  fs.mkdirSync(backups);
  fs.writeFileSync(path.join(migrations, '099_cutover.sql'), 'DROP TABLE payloads;');
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec(
    "CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (98); CREATE TABLE payloads (id TEXT PRIMARY KEY, body TEXT); INSERT INTO payloads(rowid, id, body) VALUES (7, 'old', 'first'), (99, 'latest', 'committed WAL content')",
  );
  try {
    await run({ root, db, dbPath, migrations, backups });
  } finally {
    if (db.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

it('publishes a private pre-cutover WAL snapshot with a receipt that passes isolated restore', async () => {
  await fixture(async ({ db, dbPath, migrations, backups }) => {
    await runMigrationsWithBackups(db, migrations, logger, dbPath);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='payloads'").get()).toBeUndefined();
    const names = fs.readdirSync(backups);
    expect(names).toHaveLength(2);
    const file = names.find((name) => name.endsWith('.db'));
    if (!file) throw new Error('Missing backup');
    const saved = path.join(backups, file);
    const receipt = parseBackupReceipt(fs.readFileSync(`${saved}.json`, 'utf8'));
    expect(receipt.watermark.payloads?.rows).toBe(2);
    expect(receipt.sourceIdentity).toBe(databaseIdentity(dbPath));
    expect(fs.statSync(saved).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${saved}.json`).mode & 0o777).toBe(0o600);
    expect(
      await verifyBackupRestore(saved, {
        expectedSourceIdentity: databaseIdentity(dbPath),
        maxAgeMs: 60000,
      }),
    ).toMatchObject({ watermarkScope: 'all_tables', sha256: receipt.sha256 });
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.resolve(import.meta.dirname, '../../dist/db/verify-backup-cli.js'),
          '--backup',
          saved,
          '--database',
          dbPath,
          '--max-age-minutes',
          '1',
        ],
        { encoding: 'utf8', timeout: 10000 },
      ),
    );
    expect(cli).toMatchObject({
      status: 'verified',
      watermarkScope: 'all_tables',
      sha256: receipt.sha256,
    });
    const restored = new Database(saved, { readonly: true });
    try {
      expect(restored.prepare('SELECT rowid, id, body FROM payloads ORDER BY rowid').all()).toEqual(
        [
          { rowid: 7, id: 'old', body: 'first' },
          { rowid: 99, id: 'latest', body: 'committed WAL content' },
        ],
      );
      expect(restored.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
        version: 98,
      });
    } finally {
      restored.close();
    }
  });
});

it.each(['same-connection', 'other-connection', 'migration-source'] as const)(
  'refuses migration when %s changes during backup',
  async (change) => {
    await fixture(async ({ db, dbPath, migrations }) => {
      const backup = db.backup.bind(db);
      vi.spyOn(db, 'backup').mockImplementation(async (file, options) => {
        const result = await backup(file, options);
        if (change === 'migration-source')
          fs.appendFileSync(
            path.join(migrations, '099_cutover.sql'),
            '\nCREATE TABLE replacement(id INTEGER);',
          );
        else if (change === 'same-connection')
          db.prepare("UPDATE payloads SET body='new' WHERE id='latest'").run();
        else {
          const other = new Database(dbPath);
          try {
            other.prepare("UPDATE payloads SET body='new' WHERE id='latest'").run();
          } finally {
            other.close();
          }
        }
        return result;
      });
      await expect(runMigrationsWithBackups(db, migrations, logger, dbPath)).rejects.toThrow(
        'changed during cutover backup',
      );
      expect(db.prepare('SELECT COUNT(*) AS count FROM payloads').get()).toEqual({ count: 2 });
      expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({
        version: 98,
      });
    });
  },
);

it('refuses a populated synchronous cutover without taking an unsafe file copy', async () => {
  await fixture(async ({ db, dbPath, migrations, backups }) => {
    expect(() => runMigrations(db, migrations, logger, dbPath)).toThrow('runMigrationsWithBackups');
    expect(fs.readdirSync(backups)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM payloads').get()).toEqual({ count: 2 });
  });
});

it('checks headroom before starting a cutover backup', async () => {
  await fixture(async ({ db, dbPath, migrations, backups }) => {
    const disk = fs.statfsSync(backups);
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ ...disk, bavail: 0 });
    const backup = vi.spyOn(db, 'backup');
    await expect(runMigrationsWithBackups(db, migrations, logger, dbPath)).rejects.toThrow(
      'headroom',
    );
    expect(backup).not.toHaveBeenCalled();
    expect(fs.readdirSync(backups)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM payloads').get()).toEqual({ count: 2 });
  });
});

it('does not migrate or label an orphan database as verified when receipt publication fails', async () => {
  await fixture(async ({ db, dbPath, migrations, backups }) => {
    const link = fs.linkSync;
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      if (String(destination).endsWith('.json'))
        throw new Error('fixture receipt publication failure');
      link(source, destination);
    });
    await expect(runMigrationsWithBackups(db, migrations, logger, dbPath)).rejects.toThrow(
      'receipt publication failure',
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM payloads').get()).toEqual({ count: 2 });
    const names = fs.readdirSync(backups);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.db$/);
    await expect(
      verifyBackupRestore(path.join(backups, names[0] as string), {
        expectedSourceIdentity: databaseIdentity(dbPath),
        maxAgeMs: 60000,
      }),
    ).rejects.toThrow();
  });
});

it('refuses a backup whose source pathname is replaced while the old database is open', async () => {
  await fixture(async ({ root, db, dbPath, migrations, backups }) => {
    const backup = db.backup.bind(db);
    vi.spyOn(db, 'backup').mockImplementation(async (file, options) => {
      const result = await backup(file, options);
      fs.renameSync(dbPath, path.join(root, 'retained-original.db'));
      fs.writeFileSync(dbPath, 'fixture replacement');
      return result;
    });
    await expect(runMigrationsWithBackups(db, migrations, logger, dbPath)).rejects.toThrow(
      'file identity changed',
    );
    expect(fs.readdirSync(backups)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM payloads').get()).toEqual({ count: 2 });
  });
});
