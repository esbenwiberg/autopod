import type { Profile } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { snapshotBeforeCutover } from '../db/cutover-backup.js';
import { configurationDigest } from './configuration-digest.js';
import { configurationError, createConfigurationStore } from './configuration-store.js';
import {
  applyLegacyMemoryMigration,
  previewLegacyMemoryMigration,
} from './legacy-memory-migration.js';
import { applyLegacyProfileMigration } from './legacy-profile-migration-apply.js';
import {
  type LegacyMigrationBindings,
  previewLegacyProfileMigration,
} from './legacy-profile-migration.js';
import {
  applyLegacyScheduleMigration,
  previewLegacyScheduleMigration,
} from './legacy-schedule-migration.js';
import {
  applyLegacyWatcherMigration,
  previewLegacyWatcherMigration,
} from './legacy-watcher-migration.js';

interface ConversionInput {
  db: Database.Database;
  readProfiles(): Profile[];
  bindings: LegacyMigrationBindings;
  ownerUserId: string;
}

/** One reviewable manifest, containing no prompts, memory content or credential values. */
export function previewConfigurationConversion(input: ConversionInput) {
  const profiles = previewLegacyProfileMigration(input.readProfiles(), input.bindings);
  const memory = previewLegacyMemoryMigration(input.db, profiles);
  const schedules = previewLegacyScheduleMigration(input.db, profiles, input.ownerUserId);
  const watchers = previewLegacyWatcherMigration(input.db, profiles, input.ownerUserId);
  const body = { schemaVersion: 1 as const, profiles, memory, schedules, watchers };
  return {
    ...body,
    digest: configurationDigest(body),
    blocked: !!(
      profiles.blockers.length ||
      memory.conflicts.length ||
      schedules.blockers.length ||
      watchers.blockers.length
    ),
  };
}

/** Explicit offline/drained conversion. A successful conversion never enables admission by itself. */
export async function applyConfigurationConversion(
  input: ConversionInput & { expectedDigest: string; logger: Logger; afterApply?(): void },
) {
  if (input.db.inTransaction)
    configurationError(
      'Conversion requires an idle database connection',
      'MIGRATION_TRANSACTION_ACTIVE',
      409,
    );
  const receiptId = `configuration-conversion-${input.expectedDigest}`;
  const previous = input.db
    .prepare('SELECT manifest FROM configuration_conversions WHERE id=?')
    .get(receiptId) as { manifest: string } | undefined;
  if (previous) {
    const receipt = JSON.parse(previous.manifest) as {
      digest: string;
      ownerUserId: string;
      bindingDigest: string;
      admissionEnabled: false;
    };
    if (
      receipt.digest !== input.expectedDigest ||
      receipt.ownerUserId !== input.ownerUserId ||
      receipt.bindingDigest !== configurationDigest(input.bindings)
    )
      configurationError('Conversion replay identity changed', 'MIGRATION_CONFLICT', 409);
    if (input.afterApply) input.db.transaction(input.afterApply)();
    return { ...receipt, applied: false };
  }
  const plan = previewConfigurationConversion(input);
  if (plan.digest !== input.expectedDigest)
    configurationError('Conversion plan changed since preview', 'CONFIG_CHANGED', 409);
  if (plan.blocked)
    configurationError(
      'Resolve every conversion blocker before applying',
      'MIGRATION_BLOCKED',
      409,
    );
  const sourceState = () =>
    configurationDigest([
      input.db.pragma('data_version', { simple: true }),
      input.db.pragma('schema_version', { simple: true }),
      input.db.prepare('SELECT total_changes() AS n').get(),
    ]);
  const before = sourceState();
  await snapshotBeforeCutover(
    input.db,
    input.db.name,
    input.logger,
    'pre-composable-configuration-conversion',
  );
  return input.db.transaction(() => {
    if (before !== sourceState() || previewConfigurationConversion(input).digest !== plan.digest)
      configurationError('Database changed while its backup was created', 'CONFIG_CHANGED', 409);
    applyLegacyProfileMigration({
      db: input.db,
      store: createConfigurationStore(input.db),
      readProfiles: input.readProfiles,
      bindings: input.bindings,
      expectedDigest: configurationDigest(plan.profiles),
    });
    applyLegacyMemoryMigration(input.db, plan.profiles, plan.memory.digest);
    applyLegacyScheduleMigration(input.db, plan.profiles, input.ownerUserId, plan.schedules.digest);
    applyLegacyWatcherMigration(input.db, plan.profiles, input.ownerUserId, plan.watchers.digest);
    const receipt = {
      digest: plan.digest,
      ownerUserId: input.ownerUserId,
      bindingDigest: configurationDigest(input.bindings),
      admissionEnabled: false as const,
    };
    input.db
      .prepare(
        'INSERT INTO configuration_conversions(id,source_digest,manifest,created_at) VALUES(?,?,?,?)',
      )
      .run(
        receiptId,
        configurationDigest({ conversion: plan.digest }),
        JSON.stringify(receipt),
        new Date().toISOString(),
      );
    input.afterApply?.();
    return { ...receipt, applied: true };
  })();
}
