import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { loadExistingKey, loadOrCreateKey } from '../crypto/credentials-cipher.js';
import { runMigrations } from '../db/migrate.js';
import { insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { conversionBindingsSchema } from './conversion-bindings.js';
import { readConversionProfiles, rehearseConfigurationConversion } from './conversion-rehearsal.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'autopod-conversion-test-'));
  directories.push(directory);
  const source = join(directory, 'source.db');
  const db = new Database(':memory:');
  const migrationsDirectory = fileURLToPath(new URL('../db/migrations', import.meta.url));
  runMigrations(db, migrationsDirectory, logger);
  try {
    insertTestProfile(db);
    db.prepare("UPDATE profiles SET test_command='npm test' WHERE name='test-profile'").run();
    // Exact failover policy is supplied through the mapping file, as for old account defaults.
    db.prepare("UPDATE profiles SET provider_failover=NULL WHERE name='test-profile'").run();
    await db.backup(source);
  } finally {
    db.close();
  }
  const key = join(directory, 'secrets.key');
  const cipher = loadOrCreateKey(key);
  return {
    key,
    input: {
      source,
      outputDirectory: directory,
      cipher,
      bindings: conversionBindingsSchema.parse({
        accountByProfile: { 'test-profile': 'account' },
        accountFailover: { account: null },
      }),
      ownerUserId: 'operator',
      logger,
      migrationsDirectory,
    },
  };
}

describe('offline conversion rehearsal', () => {
  it('previews and applies only to new private copies, preserving original bytes and admission state', async () => {
    const { input } = await fixture();
    const original = readFileSync(input.source);
    const preview = await rehearseConfigurationConversion(input);
    expect(preview.preview.blocked).toBe(false);
    expect(preview.receipt).toBeNull();
    const converted = await rehearseConfigurationConversion({
      ...input,
      expectedDigest: preview.preview.digest,
    });
    expect(converted.databasePath).not.toBe(preview.databasePath);
    expect(converted.receipt).toMatchObject({ applied: true, admissionEnabled: false });
    expect(readFileSync(input.source)).toEqual(original);
    expect(statSync(converted.databasePath).mode & 0o777).toBe(0o600);
    const copy = new Database(converted.databasePath, { readonly: true });
    try {
      expect(
        (copy.prepare('SELECT COUNT(*) AS n FROM configuration_entities').get() as { n: number }).n,
      ).toBeGreaterThan(0);
    } finally {
      copy.close();
    }
    await expect(
      rehearseConfigurationConversion({ ...input, expectedDigest: 'stale' }),
    ).rejects.toThrow('changed');
    expect(readFileSync(input.source)).toEqual(original);
  }, 30_000);

  it('does not drop undecipherable credentials from the conversion inventory', async () => {
    const { input } = await fixture();
    const db = new Database(input.source);
    try {
      db.prepare("UPDATE profiles SET provider_credentials=? WHERE name='test-profile'").run(
        input.cipher.encrypt(JSON.stringify({ provider: 'anthropic', apiKey: 'secret-fixture' })),
      );
      expect(readConversionProfiles(db, input.cipher)[0]?.providerCredentials).toMatchObject({
        provider: 'anthropic',
      });
      const wrong = loadOrCreateKey(join(input.outputDirectory, 'wrong.key'));
      expect(() => readConversionProfiles(db, wrong)).toThrow('could not be decoded');
      expect(() => readConversionProfiles(db, wrong)).not.toThrow('secret-fixture');
    } finally {
      db.close();
    }
  });

  it('requires the existing protected key and never generates one on read', async () => {
    const { key, input } = await fixture();
    const absent = join(input.outputDirectory, 'absent.key');
    expect(() => loadExistingKey(absent)).toThrow();
    expect(existsSync(absent)).toBe(false);
    expect(loadExistingKey(key).decrypt(input.cipher.encrypt('fixture'))).toBe('fixture');
    chmodSync(key, 0o644);
    expect(() => loadExistingKey(key)).toThrow('0600');
  });
});
