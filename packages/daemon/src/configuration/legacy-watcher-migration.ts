import { type IssueWatcherBindingPayload, issueWatcherBindingSchema } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { createWatcherBindingRepository } from '../issue-watcher/watcher-binding-repository.js';
import { configurationDigest } from './configuration-digest.js';
import { configurationError } from './configuration-store.js';
import type { LegacyMigrationManifest } from './legacy-profile-migration.js';

export function previewLegacyWatcherMigration(
  db: Database.Database,
  profiles: LegacyMigrationManifest,
  ownerUserId: string,
) {
  const bindings: Array<{
    id: string;
    legacyProfileName: string;
    payload: IssueWatcherBindingPayload;
  }> = [];
  const blockers: Array<{ legacyProfileName: string; reason: string }> = [];
  for (const binding of profiles.bindings) {
    if (!binding.repositoryId) {
      if (binding.watcher.enabled)
        blockers.push({
          legacyProfileName: binding.legacyProfileName,
          reason: 'An enabled watcher requires an enrolled repository',
        });
      continue;
    }
    const launch = (item: typeof binding) => ({
      repositoryId: item.repositoryId,
      repositorySetupId: item.setupId,
      profileId: item.profileId,
    });
    const parsed = issueWatcherBindingSchema.safeParse({
      name: binding.legacyProfileName,
      enabled: binding.watcher.enabled,
      labelPrefix: binding.watcher.labelPrefix,
      launch: launch(binding),
      targets: Object.fromEntries(
        profiles.bindings
          .filter(
            (item) =>
              item.repositoryId === binding.repositoryId &&
              !['artifact', 'in-progress', 'done', 'failed'].includes(item.legacyProfileName),
          )
          .map((item) => [item.legacyProfileName, launch(item)]),
      ),
    });
    if (!parsed.success) {
      blockers.push({
        legacyProfileName: binding.legacyProfileName,
        reason: 'Watcher label routes or repository setup cannot be represented',
      });
      continue;
    }
    bindings.push({
      id: `watcher-${configurationDigest(binding.legacyProfileName).slice(0, 24)}`,
      legacyProfileName: binding.legacyProfileName,
      payload: parsed.data,
    });
  }
  const active = db
    .prepare("SELECT id,profile_name FROM watched_issues WHERE status='in_progress' ORDER BY id")
    .all() as Array<{ id: number; profile_name: string }>;
  const scopes = new Set<string>();
  for (const binding of bindings.filter((item) => item.payload.enabled)) {
    const key = JSON.stringify([binding.payload.launch.repositoryId, binding.payload.labelPrefix]);
    if (scopes.has(key))
      blockers.push({
        legacyProfileName: binding.legacyProfileName,
        reason:
          'Choose one enabled watcher for this repository and label prefix in watcherEnabledByProfile',
      });
    scopes.add(key);
  }
  for (const issue of active)
    blockers.push({
      legacyProfileName: issue.profile_name,
      reason: `Reconcile tracked issue ${issue.id} before conversion`,
    });
  const tracked = db
    .prepare(
      'SELECT id,profile_name,provider,issue_id,status,pod_id,phase,trigger_label,updated_at FROM watched_issues ORDER BY id',
    )
    .all();
  const body = { ownerUserId, bindings, blockers, trackedDigest: configurationDigest(tracked) };
  return { ...body, digest: configurationDigest(body) };
}
export function applyLegacyWatcherMigration(
  db: Database.Database,
  profiles: LegacyMigrationManifest,
  ownerUserId: string,
  expectedDigest: string,
) {
  return db.transaction(() => {
    const plan = previewLegacyWatcherMigration(db, profiles, ownerUserId);
    if (plan.digest !== expectedDigest)
      configurationError('Watcher conversion source changed', 'CONFIG_CHANGED', 409);
    if (plan.blockers.length)
      configurationError('Resolve watcher conversion blockers', 'MIGRATION_BLOCKED', 409);
    const repository = createWatcherBindingRepository(db);
    for (const binding of plan.bindings) {
      if (db.prepare('SELECT 1 FROM issue_watcher_bindings WHERE id=?').get(binding.id))
        configurationError(
          'Watcher conversion destination already exists',
          'MIGRATION_CONFLICT',
          409,
        );
      repository.write({ id: binding.id, payload: binding.payload }, ownerUserId);
      db.prepare('UPDATE watched_issues SET watcher_id=? WHERE profile_name=?').run(
        binding.id,
        binding.legacyProfileName,
      );
    }
    return plan;
  })();
}
