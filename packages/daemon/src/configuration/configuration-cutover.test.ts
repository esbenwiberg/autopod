import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createDeploymentRunRepository } from '../actions/deployment-run-repository.js';
import { loadOrCreateKey } from '../crypto/credentials-cipher.js';
import { runMigrations } from '../db/migrate.js';
import { insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import {
  applyOfflineConfigurationCutover,
  readConfigurationCutover,
  restoreConfigurationCutoverCandidate,
} from './configuration-cutover.js';
import { conversionBindingsSchema } from './conversion-bindings.js';
import { rehearseConfigurationConversion } from './conversion-rehearsal.js';
import { configurationCutoverReadiness } from './cutover-readiness.js';
import { configurationDatabaseFingerprint } from './database-fingerprint.js';

const directories: string[] = [];
it('refuses cutover while a deployment still awaits an operator decision', async () => {
  const { input } = await fixture();
  const db = new Database(input.databasePath);
  createDeploymentRunRepository(db).reserve({
    podId: 'former-pod',
    operationKey: 'deploy',
    ownerId: 'operator',
    targetId: 'prod',
    repositoryId: 'repo',
    setupId: 'default',
    launchDigest: 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40),
    sourceKind: 'published-default',
    sourceBranch: 'main',
    runnerDigest: 'e'.repeat(64),
    sourceDigest: 'c'.repeat(64),
    scriptDigest: 'd'.repeat(64),
    scriptPath: 'deploy.sh',
    args: [],
    image: `fixture@sha256:${'e'.repeat(64)}`,
    environmentDigest: 'f'.repeat(64),
    credentialRevisions: {},
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  db.close();
  await expect(applyOfflineConfigurationCutover(input)).rejects.toThrow(
    'deployments before cutover',
  );
});
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'autopod-cutover-test-'));
  directories.push(directory);
  const databasePath = join(directory, 'source.db');
  const keyPath = join(directory, 'secrets.key');
  const cipher = loadOrCreateKey(keyPath);
  const migrationsDirectory = fileURLToPath(new URL('../db/migrations', import.meta.url));
  const db = new Database(':memory:');
  runMigrations(db, migrationsDirectory, logger);
  insertTestProfile(db);
  db.prepare(
    "UPDATE profiles SET test_command='npm test',provider_failover=NULL WHERE name='test-profile'",
  ).run();
  await db.backup(databasePath);
  db.close();
  const file = new Database(databasePath);
  file.pragma('journal_mode = WAL');
  file.close();
  const bindings = conversionBindingsSchema.parse({
    accountByProfile: { 'test-profile': 'account' },
    accountFailover: { account: null },
  });
  const preview = await rehearseConfigurationConversion({
    source: databasePath,
    outputDirectory: directory,
    migrationsDirectory,
    cipher,
    bindings,
    ownerUserId: 'operator',
    logger,
  });
  expect(preview.preview.blocked).toBe(false);
  return {
    directory,
    input: {
      databasePath,
      keyPath,
      migrationsDirectory,
      bindings,
      ownerUserId: 'operator',
      logger,
      expectedSourceIdentity: preview.sourceIdentity,
      expectedSourceFingerprint: preview.sourceFingerprint,
      expectedConversionDigest: preview.preview.digest,
    },
  };
}

it('converts once under an exclusive lock and restores a new candidate with the original key', async () => {
  const { directory, input } = await fixture();
  const key = readFileSync(input.keyPath);
  const result = await applyOfflineConfigurationCutover(input);
  expect(result).toMatchObject({ applied: true, receipt: { admissionEnabled: false } });
  expect(statSync(result.receipt.keyBackupPath).mode & 0o777).toBe(0o600);
  expect(await applyOfflineConfigurationCutover(input)).toEqual({ ...result, applied: false });
  const db = new Database(input.databasePath);
  const converted = configurationDatabaseFingerprint(db);
  expect(readConfigurationCutover(db)).toEqual(result.receipt);
  expect(configurationCutoverReadiness(db, false).ready).toBe(false);
  expect(configurationCutoverReadiness(db, true).ready).toBe(true);
  expect(() => db.prepare('DELETE FROM configuration_cutover').run()).toThrow('immutable');
  db.close();
  const restored = await restoreConfigurationCutoverCandidate({
    ...input,
    outputDirectory: directory,
  });
  expect(restored.databasePath).not.toBe(input.databasePath);
  expect(readFileSync(restored.keyPath)).toEqual(key);
  const check = new Database(restored.databasePath);
  expect(configurationDatabaseFingerprint(check)).toBe(input.expectedSourceFingerprint);
  check.close();
  const current = new Database(input.databasePath);
  expect(configurationDatabaseFingerprint(current)).toBe(converted);
  current.close();
});

it('refuses stale state or a competing writer before converting', async () => {
  const { input } = await fixture();
  const db = new Database(input.databasePath);
  db.exec('BEGIN IMMEDIATE');
  await expect(applyOfflineConfigurationCutover(input)).rejects.toThrow();
  db.exec('ROLLBACK');
  db.prepare("UPDATE profiles SET test_command='different' WHERE name='test-profile'").run();
  db.close();
  await expect(applyOfflineConfigurationCutover(input)).rejects.toThrow('changed after rehearsal');
  const current = new Database(input.databasePath);
  expect(current.prepare('SELECT COUNT(*) AS n FROM configuration_entities').get()).toEqual({
    n: 0,
  });
  expect(readConfigurationCutover(current)).toBeNull();
  expect(configurationCutoverReadiness(current, true).ready).toBe(false);
  current.close();
});

it('refuses rollback when any durable state changed after cutover, even without a new pod', async () => {
  const { directory, input } = await fixture();
  await applyOfflineConfigurationCutover(input);
  const db = new Database(input.databasePath);
  db.prepare(
    "UPDATE profiles SET test_command='new external-effect reconciliation' WHERE name='test-profile'",
  ).run();
  db.close();
  await expect(
    restoreConfigurationCutoverCandidate({ ...input, outputDirectory: directory }),
  ).rejects.toThrow('Post-cutover state changed');
});

it('does not alter source configuration when the reviewed conversion digest is wrong', async () => {
  const { input } = await fixture();
  await expect(
    applyOfflineConfigurationCutover({ ...input, expectedConversionDigest: 'a'.repeat(64) }),
  ).rejects.toThrow();
  const current = new Database(input.databasePath);
  expect(configurationDatabaseFingerprint(current)).toBe(input.expectedSourceFingerprint);
  expect(readConfigurationCutover(current)).toBeNull();
  expect(configurationCutoverReadiness(current, true).ready).toBe(false);
  current.close();
});

it('rolls conversion back if its cutover receipt cannot commit', async () => {
  const { input } = await fixture();
  const db = new Database(input.databasePath);
  db.exec(
    "CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON configuration_cutover BEGIN SELECT RAISE(ABORT, 'receipt storage unavailable'); END;",
  );
  input.expectedSourceFingerprint = configurationDatabaseFingerprint(db);
  db.close();
  await expect(applyOfflineConfigurationCutover(input)).rejects.toThrow(
    'receipt storage unavailable',
  );
  const current = new Database(input.databasePath);
  expect(configurationDatabaseFingerprint(current)).toBe(input.expectedSourceFingerprint);
  expect(current.prepare('SELECT COUNT(*) AS n FROM configuration_entities').get()).toEqual({
    n: 0,
  });
  expect(readConfigurationCutover(current)).toBeNull();
  current.close();
});
