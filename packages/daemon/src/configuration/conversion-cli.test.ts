import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { loadOrCreateKey } from '../crypto/credentials-cipher.js';
import { runMigrations } from '../db/migrate.js';
import { insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { configurationDatabaseFingerprint } from './database-fingerprint.js';

const exec = promisify(execFile);
it('rehearses, applies once and restores through the built offline commands without enabling admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autopod-built-cutover-'));
  const source = join(root, 'source.db');
  const key = join(root, 'secrets.key');
  const bindings = join(root, 'bindings.json');
  const cli = (name: string) =>
    fileURLToPath(new URL(`../../dist/configuration/${name}-cli.js`, import.meta.url));
  const call = async (name: string, args: string[]) => {
    const result = await exec(process.execPath, [cli(name), ...args], {
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  };
  const bytes = () => createHash('sha256').update(readFileSync(source)).digest('hex');
  try {
    loadOrCreateKey(key);
    const db = new Database(':memory:');
    try {
      runMigrations(db, fileURLToPath(new URL('../db/migrations', import.meta.url)), logger);
      insertTestProfile(db);
      db.prepare(
        "UPDATE profiles SET test_command='npm test',provider_failover=NULL WHERE name='test-profile'",
      ).run();
      await db.backup(source);
    } finally {
      db.close();
    }
    writeFileSync(
      bindings,
      JSON.stringify({
        accountByProfile: { 'test-profile': 'account' },
        accountFailover: { account: null },
      }),
      { mode: 0o600 },
    );
    const before = bytes();
    const preview = await call('conversion', [
      '--source',
      source,
      '--output-directory',
      root,
      '--secrets-key',
      key,
      '--owner',
      'fixture-operator',
      '--bindings',
      bindings,
    ]);
    expect(preview.preview.blocked).toBe(false);
    expect(bytes()).toBe(before);
    const args = [
      '--operation',
      'apply-reviewed',
      '--database',
      source,
      '--secrets-key',
      key,
      '--source-identity',
      preview.sourceIdentity,
      '--source-fingerprint',
      preview.sourceFingerprint,
      '--conversion-digest',
      preview.preview.digest,
      '--owner',
      'fixture-operator',
      '--bindings',
      bindings,
    ];
    expect(await call('cutover', args)).toMatchObject({
      applied: true,
      receipt: { admissionEnabled: false },
    });
    expect(await call('cutover', args)).toMatchObject({ applied: false });
    const restoreArgs = [
      '--operation',
      'restore-candidate',
      '--database',
      source,
      '--secrets-key',
      key,
      '--conversion-digest',
      preview.preview.digest,
      '--output-directory',
      root,
    ];
    const restored = await call('cutover', restoreArgs);
    expect(restored.databasePath).not.toBe(source);
    expect(readFileSync(restored.keyPath)).toEqual(readFileSync(key));
    const restoredDb = new Database(restored.databasePath);
    try {
      expect(configurationDatabaseFingerprint(restoredDb)).toBe(preview.sourceFingerprint);
    } finally {
      restoredDb.close();
    }
    const live = new Database(source);
    try {
      live.exec('CREATE TABLE subsequent_effects (id TEXT PRIMARY KEY)');
    } finally {
      live.close();
    }
    await expect(call('cutover', restoreArgs)).rejects.toMatchObject({ code: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
