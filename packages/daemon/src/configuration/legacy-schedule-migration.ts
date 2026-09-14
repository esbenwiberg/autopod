import { savedLaunchSelectionSchema, scheduledScanPolicySchema } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { createScheduledJobRepository } from '../scheduled-jobs/scheduled-job-repository.js';
import { configurationDigest } from './configuration-digest.js';
import { configurationError, createConfigurationStore } from './configuration-store.js';
import type { LegacyMigrationManifest } from './legacy-profile-migration.js';

/** Preview every legacy schedule. No implicit disabling or repository guessing. */
export function previewLegacyScheduleMigration(
  db: Database.Database,
  manifest: LegacyMigrationManifest,
  ownerUserId: string,
) {
  if (!ownerUserId.trim() || ownerUserId === 'scheduler')
    configurationError(
      'Select the authenticated operator who owns these schedules',
      'SCHEDULE_OWNER_REQUIRED',
    );
  const rows = db
    .prepare('SELECT * FROM scheduled_jobs WHERE launch_selection IS NULL ORDER BY id')
    .all() as Array<
    Record<string, unknown> & {
      id: string;
      profile_name: string | null;
      scan_policy: string | null;
    }
  >;
  const mappings: Array<{
    id: string;
    legacyProfileName: string;
    rowDigest: string;
    launch: ReturnType<typeof savedLaunchSelectionSchema.parse>;
  }> = [];
  const blockers: Array<{ id: string; reason: string }> = [];
  for (const row of rows) {
    if (row.scan_policy) {
      try {
        scheduledScanPolicySchema.parse(JSON.parse(row.scan_policy));
      } catch {
        blockers.push({
          id: row.id,
          reason: 'Scan policy is malformed or unsupported; reconcile the original policy',
        });
        continue;
      }
    }
    const binding = manifest.bindings.find((item) => item.legacyProfileName === row.profile_name);
    if (!binding || !row.profile_name) {
      blockers.push({ id: row.id, reason: 'No exact converted profile and repository mapping' });
      continue;
    }
    if (row.scan_policy && !binding.repositoryId) {
      blockers.push({ id: row.id, reason: 'A deterministic scan requires an enrolled repository' });
      continue;
    }
    const launch = savedLaunchSelectionSchema.parse({
      ...(binding.repositoryId
        ? { repositoryId: binding.repositoryId, repositorySetupId: binding.setupId ?? undefined }
        : { emptyWorkspace: true }),
      profileId: binding.profileId,
    });
    mappings.push({
      id: row.id,
      legacyProfileName: row.profile_name,
      rowDigest: configurationDigest(row),
      launch,
    });
  }
  const body = {
    schemaVersion: 1 as const,
    ownerUserId,
    profileSourceDigest: manifest.sourceDigest,
    bindingDigest: configurationDigest(manifest.bindings),
    mappings,
    blockers,
  };
  return { ...body, digest: configurationDigest(body) };
}

/** Transactional conversion only. Scheduling resumes separately after complete caller cutover. */
export function applyLegacyScheduleMigration(
  db: Database.Database,
  manifest: LegacyMigrationManifest,
  ownerUserId: string,
  expectedDigest: string,
) {
  return db.transaction(() => {
    const id = `schedule-conversion-${expectedDigest}`;
    const prior = db.prepare('SELECT manifest FROM configuration_conversions WHERE id=?').get(id) as
      | { manifest: string }
      | undefined;
    if (prior) {
      const report = JSON.parse(prior.manifest) as ReturnType<
        typeof previewLegacyScheduleMigration
      >;
      const { digest, ...body } = report;
      if (
        digest !== expectedDigest ||
        configurationDigest(body) !== digest ||
        report.ownerUserId !== ownerUserId ||
        report.bindingDigest !== configurationDigest(manifest.bindings)
      )
        configurationError('Scheduled conversion identity changed', 'MIGRATION_CONFLICT', 409);
      return { report, applied: false };
    }
    const report = previewLegacyScheduleMigration(db, manifest, ownerUserId);
    if (report.digest !== expectedDigest)
      configurationError('Schedules changed since conversion preview', 'CONFIG_CHANGED', 409);
    if (report.blockers.length || manifest.blockers.length)
      configurationError('Resolve conversion blockers first', 'MIGRATION_BLOCKED', 409);
    if (
      db.prepare("SELECT 1 FROM pods WHERE status NOT IN ('complete','killed') LIMIT 1").get() ||
      db
        .prepare(
          "SELECT 1 FROM managed_pods WHERE observed_exit=0 OR state NOT IN ('complete','killed') LIMIT 1",
        )
        .get()
    )
      configurationError('Drain pods before converting schedules', 'MIGRATION_ACTIVE_PODS', 409);
    const store = createConfigurationStore(db);
    const schedules = createScheduledJobRepository(db);
    for (const mapping of report.mappings) {
      const launch = mapping.launch;
      if (!launch.profileId)
        configurationError(
          'Converted profile binding is missing',
          'MIGRATION_BINDING_MISSING',
          409,
        );
      store.get('profile', launch.profileId);
      if ('repositoryId' in launch) {
        const repository = store.get('repository', launch.repositoryId);
        if (!repository.payload.setups.some((setup) => setup.id === launch.repositorySetupId))
          configurationError(
            'Converted repository setup is missing',
            'MIGRATION_BINDING_MISSING',
            409,
          );
      }
      const original = db
        .prepare('SELECT updated_at FROM scheduled_jobs WHERE id=?')
        .get(mapping.id) as { updated_at: string };
      schedules.update(mapping.id, { launch: mapping.launch, ownerUserId, profileName: null });
      // Scope conversion is not a user edit to the schedule, prompt or run history.
      db.prepare('UPDATE scheduled_jobs SET updated_at=? WHERE id=?').run(
        original.updated_at,
        mapping.id,
      );
    }
    db.prepare(
      'INSERT INTO configuration_conversions(id,source_digest,manifest,created_at) VALUES(?,?,?,?)',
    ).run(
      id,
      configurationDigest({ schedules: report.digest }),
      JSON.stringify(report),
      new Date().toISOString(),
    );
    return { report, applied: true };
  })();
}
