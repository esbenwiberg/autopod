import type { Profile } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { type ConfigurationStore, configurationError } from './configuration-store.js';
import { configurationDigest } from './launch-resolver.js';
import {
  type LegacyMigrationBindings,
  previewLegacyProfileMigration,
} from './legacy-profile-migration.js';

/** Applies a reviewed additive conversion on a drained/copied database. Destructive cutover is separate. */
export function applyLegacyProfileMigration(input: {
  db: Database.Database;
  store: ConfigurationStore;
  readProfiles: () => Profile[];
  bindings: LegacyMigrationBindings;
  expectedDigest: string;
}) {
  return input.db.transaction(() => {
    const manifest = previewLegacyProfileMigration(input.readProfiles(), input.bindings);
    if (manifest.blockers.length)
      configurationError(
        'Resolve all conversion blockers before applying',
        'MIGRATION_BLOCKED',
        409,
      );
    const digest = configurationDigest(manifest);
    if (digest !== input.expectedDigest)
      configurationError('Conversion source or mapping changed', 'CONFIG_CHANGED', 409);
    const previous = input.db
      .prepare('SELECT manifest FROM configuration_conversions WHERE source_digest=?')
      .get(manifest.sourceDigest) as { manifest: string } | undefined;
    if (previous) {
      if (configurationDigest(JSON.parse(previous.manifest)) !== digest)
        configurationError(
          'This source was converted with different mappings',
          'MIGRATION_CONFLICT',
          409,
        );
      return { manifest, applied: false };
    }
    if (
      input.db.prepare("SELECT 1 FROM pods WHERE status NOT IN ('complete','killed') LIMIT 1").get()
    ) {
      configurationError(
        'Drain existing pods before converting configuration',
        'MIGRATION_ACTIVE_PODS',
        409,
      );
    }
    if (
      input.db
        .prepare(
          "SELECT 1 FROM managed_pods WHERE observed_exit=0 OR state NOT IN ('complete','killed') LIMIT 1",
        )
        .get()
    ) {
      configurationError(
        'Drain existing managed attempts before converting configuration',
        'MIGRATION_ACTIVE_PODS',
        409,
      );
    }
    input.store.writeBatch(manifest.entities);
    input.db
      .prepare(
        'INSERT INTO configuration_conversions(id,source_digest,manifest,created_at) VALUES(?,?,?,?)',
      )
      .run(
        `conversion-${digest.slice(0, 24)}`,
        manifest.sourceDigest,
        JSON.stringify(manifest),
        new Date().toISOString(),
      );
    return { manifest, applied: true };
  })();
}
