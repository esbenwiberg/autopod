import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Profile, providerCredentialsSchema } from '@autopod/shared';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { CredentialsCipher } from '../crypto/credentials-cipher.js';
import { databaseIdentity } from '../db/backup-verification.js';
import { runMigrationsWithBackups } from '../db/migrate.js';
import { rowToProfile } from '../profiles/profile-store.js';
import { configurationError } from './configuration-store.js';
import { configurationDatabaseFingerprint } from './database-fingerprint.js';
import {
  applyConfigurationConversion,
  previewConfigurationConversion,
} from './legacy-configuration-conversion.js';
import type { LegacyMigrationBindings } from './legacy-profile-migration.js';

/** Unlike the live compatibility reader, never treats failed decryption as absent credentials. */
export function readConversionProfiles(
  db: Database.Database,
  cipher: CredentialsCipher,
): Profile[] {
  const decrypt = (raw: unknown): string | null => {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'string')
      configurationError(
        'Legacy credential encoding is invalid',
        'MIGRATION_CREDENTIAL_UNREADABLE',
      );
    return /^[a-f0-9]{24}:[a-f0-9]{32}:/i.test(raw) ? cipher.decrypt(raw) : raw;
  };
  try {
    return (
      db.prepare('SELECT * FROM profiles ORDER BY name').all() as Record<string, unknown>[]
    ).map((row) =>
      rowToProfile(
        row,
        (raw) => {
          const json = decrypt(raw);
          return json === null ? null : providerCredentialsSchema.parse(JSON.parse(json));
        },
        decrypt,
      ),
    );
  } catch {
    configurationError(
      'Legacy configuration could not be decoded with the supplied key; source retained unchanged',
      'MIGRATION_CREDENTIAL_UNREADABLE',
    );
  }
}

/** Always operates on a new private copy, including migrations and optional conversion rehearsal. */
export async function rehearseConfigurationConversion(input: {
  source: string;
  outputDirectory: string;
  migrationsDirectory: string;
  cipher: CredentialsCipher;
  bindings: LegacyMigrationBindings;
  ownerUserId: string;
  expectedDigest?: string;
  logger: Logger;
}) {
  if (!input.ownerUserId.trim()) configurationError('Conversion owner is required');
  const source = new Database(resolve(input.source), { readonly: true, fileMustExist: true });
  let copy: Database.Database | undefined;
  try {
    const directory = mkdtempSync(join(resolve(input.outputDirectory), 'configuration-rehearsal-'));
    chmodSync(directory, 0o700);
    // Keep all migration backups within this rehearsal, never in an ancestor's backup directory.
    mkdirSync(join(directory, 'backups'), { mode: 0o700 });
    const databasePath = join(directory, 'configuration.db');
    const deadline = performance.now() + 120_000;
    await source.backup(databasePath, {
      progress: () => {
        if (performance.now() >= deadline) throw new Error('Configuration copy timed out');
        return 1000;
      },
    });
    chmodSync(databasePath, 0o600);
    copy = new Database(databasePath, { fileMustExist: true });
    copy.pragma('foreign_keys = ON');
    const sourceFingerprint = configurationDatabaseFingerprint(copy);
    await runMigrationsWithBackups(copy, input.migrationsDirectory, input.logger, databasePath);
    const db = copy;
    const options = {
      db,
      readProfiles: () => readConversionProfiles(db, input.cipher),
      bindings: input.bindings,
      ownerUserId: input.ownerUserId,
    };
    const preview = previewConfigurationConversion(options);
    const receipt =
      input.expectedDigest === undefined
        ? null
        : await applyConfigurationConversion({
            ...options,
            expectedDigest: input.expectedDigest,
            logger: input.logger,
          });
    if (
      copy.pragma('integrity_check', { simple: true }) !== 'ok' ||
      copy.pragma('foreign_key_check').length
    )
      configurationError('Rehearsal database integrity failed', 'MIGRATION_INTEGRITY_FAILED');
    return {
      databasePath,
      sourceFingerprint,
      sourceIdentity: databaseIdentity(input.source),
      sourceModified: false as const,
      admissionEnabled: false as const,
      preview,
      receipt,
    };
  } finally {
    copy?.close();
    source.close();
  }
}
