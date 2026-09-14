import { createHash } from 'node:crypto';
import {
  constants,
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { z } from 'zod';
import { loadExistingKey } from '../crypto/credentials-cipher.js';
import {
  assertBackupIntegrity,
  databaseIdentity,
  fileChecksum,
  verifyBackupRestore,
} from '../db/backup-verification.js';
import { snapshotBeforeCutover } from '../db/cutover-backup.js';
import { runMigrationsWithBackups } from '../db/migrate.js';
import { configurationDigest } from './configuration-digest.js';
import { readConversionProfiles, rehearseConfigurationConversion } from './conversion-rehearsal.js';
import { configurationDatabaseFingerprint } from './database-fingerprint.js';
import { applyConfigurationConversion } from './legacy-configuration-conversion.js';
import type { LegacyMigrationBindings } from './legacy-profile-migration.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z
  .object({
    version: z.literal(1),
    sourceIdentity: digest,
    sourceFingerprint: digest,
    convertedFingerprint: digest,
    conversionDigest: digest,
    bindingDigest: digest,
    ownerUserId: z.string().min(1),
    backupPath: z.string().min(1),
    backupSha256: digest,
    keyBackupPath: z.string().min(1),
    keySha256: digest,
    admissionEnabled: z.literal(false),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ConfigurationCutoverReceipt = z.infer<typeof receiptSchema>;

function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Holds an exclusive SQLite connection until close. A competing daemon/CLI cannot write during cutover.
 * The operator must stop the old daemon before invoking this tool; this never kills or pauses a process.
 */
function exclusiveDatabase(file: string): Database.Database {
  const db = new Database(resolve(file), { fileMustExist: true, timeout: 100 });
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE; COMMIT;');
    db.pragma('foreign_keys = ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function readConfigurationCutover(
  db: Database.Database,
): ConfigurationCutoverReceipt | null {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='configuration_cutover'")
      .get()
  )
    return null;
  const row = db.prepare('SELECT receipt FROM configuration_cutover WHERE id=1').get() as
    | { receipt: string }
    | undefined;
  return row ? receiptSchema.parse(JSON.parse(row.receipt)) : null;
}
function assertDrained(db: Database.Database): void {
  if (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deployment_runs'").get() &&
    db
      .prepare(
        "SELECT 1 FROM deployment_runs WHERE state IN ('awaiting_approval','approved','running','uncertain') LIMIT 1",
      )
      .get()
  )
    throw new Error(
      'Resolve pending or uncertain deployments before cutover; no deployment was restarted',
    );
  if (db.prepare("SELECT 1 FROM pods WHERE status NOT IN ('complete','killed') LIMIT 1").get())
    throw new Error('Drain regular pods before cutover; no pod was killed');
  if (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_pods'").get() &&
    db
      .prepare(
        "SELECT 1 FROM managed_pods WHERE observed_exit=0 OR state NOT IN ('complete','killed') LIMIT 1",
      )
      .get()
  )
    throw new Error('Drain managed attempts before cutover; no attempt was killed');
}
function keyDigest(path: string): string {
  // Validate the original key format and permissions before reading its bytes for identity.
  loadExistingKey(path);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Explicit offline apply. Records conversion but never enables admission or starts a dispatcher. */
export async function applyOfflineConfigurationCutover(input: {
  databasePath: string;
  expectedSourceIdentity: string;
  expectedSourceFingerprint: string;
  expectedConversionDigest: string;
  keyPath: string;
  migrationsDirectory: string;
  bindings: LegacyMigrationBindings;
  ownerUserId: string;
  logger: Logger;
}): Promise<{ receipt: ConfigurationCutoverReceipt; applied: boolean }> {
  const sourceIdentity = databaseIdentity(input.databasePath);
  if (sourceIdentity !== input.expectedSourceIdentity)
    throw new Error('Database path identity differs from the reviewed source');
  const keySha256 = keyDigest(input.keyPath);
  const cipher = loadExistingKey(input.keyPath);
  const db = exclusiveDatabase(input.databasePath);
  try {
    const prior = readConfigurationCutover(db);
    if (prior) {
      if (
        prior.sourceIdentity !== sourceIdentity ||
        prior.sourceFingerprint !== input.expectedSourceFingerprint ||
        prior.conversionDigest !== input.expectedConversionDigest ||
        prior.ownerUserId !== input.ownerUserId ||
        prior.bindingDigest !== configurationDigest(input.bindings) ||
        prior.keySha256 !== keySha256
      )
        throw new Error('Cutover retry differs from its original receipt');
      return { receipt: prior, applied: false };
    }
    assertBackupIntegrity(db);
    assertDrained(db);
    const sourceFingerprint = configurationDatabaseFingerprint(db);
    if (sourceFingerprint !== input.expectedSourceFingerprint)
      throw new Error('Database contents changed after rehearsal');
    const backup = await snapshotBeforeCutover(
      db,
      input.databasePath,
      input.logger,
      'before-configuration-cutover',
    );
    if (!backup) throw new Error('Offline cutover requires a persistent database backup');
    const keyDirectory = mkdtempSync(join(dirname(backup.path), '.configuration-key-'));
    chmodSync(keyDirectory, 0o700);
    const keyBackupPath = join(keyDirectory, 'secrets.key');
    writeFileSync(keyBackupPath, readFileSync(input.keyPath), { mode: 0o600, flag: 'wx' });
    syncPath(keyBackupPath);
    syncPath(keyDirectory);
    syncPath(dirname(keyDirectory));
    if (keyDigest(keyBackupPath) !== keySha256) throw new Error('Key changed during backup');
    await verifyBackupRestore(backup.path, {
      expectedSourceIdentity: sourceIdentity,
      maxAgeMs: 120_000,
    });
    const rehearsal = await rehearseConfigurationConversion({
      source: backup.path,
      outputDirectory: keyDirectory,
      migrationsDirectory: input.migrationsDirectory,
      cipher,
      bindings: input.bindings,
      ownerUserId: input.ownerUserId,
      expectedDigest: input.expectedConversionDigest,
      logger: input.logger,
    });
    if (rehearsal.preview.blocked || rehearsal.sourceFingerprint !== sourceFingerprint)
      throw new Error('Cutover rehearsal does not match the reviewed source');
    await runMigrationsWithBackups(db, input.migrationsDirectory, input.logger, input.databasePath);
    let receipt: ConfigurationCutoverReceipt | undefined;
    await applyConfigurationConversion({
      db,
      readProfiles: () => readConversionProfiles(db, cipher),
      bindings: input.bindings,
      ownerUserId: input.ownerUserId,
      expectedDigest: input.expectedConversionDigest,
      logger: input.logger,
      afterApply() {
        assertDrained(db);
        assertBackupIntegrity(db);
        if (keyDigest(input.keyPath) !== keySha256)
          throw new Error('Key changed during conversion');
        const value = receiptSchema.parse({
          version: 1,
          sourceIdentity,
          sourceFingerprint,
          convertedFingerprint: configurationDatabaseFingerprint(db),
          conversionDigest: input.expectedConversionDigest,
          bindingDigest: configurationDigest(input.bindings),
          ownerUserId: input.ownerUserId,
          backupPath: backup.path,
          backupSha256: backup.receipt.sha256,
          keyBackupPath,
          keySha256,
          admissionEnabled: false,
          createdAt: new Date().toISOString(),
        });
        db.prepare('INSERT INTO configuration_cutover(id,receipt,created_at) VALUES(1,?,?)').run(
          JSON.stringify(value),
          value.createdAt,
        );
        receipt = value;
      },
    });
    if (!receipt) throw new Error('Cutover receipt was not committed');
    return { receipt, applied: true };
  } finally {
    db.close();
  }
}

/** Restores to a NEW private candidate. Refuses any post-cutover state change, not merely new pod counts.
 * Selecting this DB/key for a stopped daemon is a separate operator action.
 */
export async function restoreConfigurationCutoverCandidate(input: {
  databasePath: string;
  keyPath: string;
  expectedConversionDigest: string;
  outputDirectory: string;
}) {
  const db = exclusiveDatabase(input.databasePath);
  try {
    const receipt = readConfigurationCutover(db);
    if (
      !receipt ||
      receipt.conversionDigest !== input.expectedConversionDigest ||
      receipt.sourceIdentity !== databaseIdentity(input.databasePath)
    )
      throw new Error('Cutover receipt does not match the requested database and conversion');
    if (
      keyDigest(input.keyPath) !== receipt.keySha256 ||
      keyDigest(receipt.keyBackupPath) !== receipt.keySha256
    )
      throw new Error('Key state changed after cutover; automatic rollback is unavailable');
    if (configurationDatabaseFingerprint(db) !== receipt.convertedFingerprint)
      throw new Error(
        'Post-cutover state changed. Reconcile and retain new work and external effects before rollback',
      );
    if ((await fileChecksum(receipt.backupPath)) !== receipt.backupSha256)
      throw new Error('Original backup checksum changed');
    await verifyBackupRestore(receipt.backupPath, {
      expectedSourceIdentity: receipt.sourceIdentity,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
    });
    const directory = mkdtempSync(join(resolve(input.outputDirectory), 'configuration-restore-'));
    chmodSync(directory, 0o700);
    const databasePath = join(directory, 'restored.db');
    const keyPath = join(directory, 'secrets.key');
    copyFileSync(receipt.backupPath, databasePath, constants.COPYFILE_EXCL);
    chmodSync(databasePath, 0o600);
    copyFileSync(receipt.keyBackupPath, keyPath, constants.COPYFILE_EXCL);
    chmodSync(keyPath, 0o600);
    const restored = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      assertBackupIntegrity(restored);
      if (configurationDatabaseFingerprint(restored) !== receipt.sourceFingerprint)
        throw new Error('Restored source content differs');
    } finally {
      restored.close();
    }
    syncPath(databasePath);
    syncPath(keyPath);
    syncPath(directory);
    return {
      databasePath,
      keyPath,
      sourceModified: false as const,
      admissionEnabled: false as const,
    };
  } finally {
    db.close();
  }
}
