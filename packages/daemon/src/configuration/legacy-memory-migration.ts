import type Database from 'better-sqlite3';
import { configurationDigest } from './configuration-digest.js';
import { configurationError, createConfigurationStore } from './configuration-store.js';
import type { LegacyMigrationManifest } from './legacy-profile-migration.js';

interface MemoryRow {
  id: string;
  scope_id: string;
  path: string;
  repository_setup_id: string | null;
  [key: string]: unknown;
}
const tables = ['memory_entries', 'memory_candidates'] as const;

/** Redacted, deterministic conversion plan. Content and audit fields are fingerprinted, never exposed. */
export function previewLegacyMemoryMigration(
  db: Database.Database,
  manifest: LegacyMigrationManifest,
) {
  const mappings: Array<{
    table: (typeof tables)[number];
    id: string;
    legacyProfileName: string;
    repositoryId: string;
    setupId: string;
    rowDigest: string;
  }> = [];
  const retained: Array<{
    table: (typeof tables)[number];
    id: string;
    legacyProfileName: string;
    reason: string;
  }> = [];
  const conflicts: Array<{ table: (typeof tables)[number]; id: string; reason: string }> = [];
  const rowsByTable = tables.map((table) => ({
    table,
    rows: db
      .prepare(`SELECT * FROM ${table} WHERE scope='profile' ORDER BY id`)
      .all() as MemoryRow[],
  }));
  for (const { table, rows } of rowsByTable) {
    const destinations = new Map<string, string>();
    for (const row of rows) {
      const binding = manifest.bindings.find((item) => item.legacyProfileName === row.scope_id);
      if (!binding?.repositoryId || !binding.setupId) {
        retained.push({
          table,
          id: row.id,
          legacyProfileName: row.scope_id,
          reason: 'No unambiguous repository and setup mapping; retain restricted legacy scope',
        });
        continue;
      }
      const key = configurationDigest([binding.repositoryId, binding.setupId, row.path]);
      // Multiple candidates may propose the same path. Existing memories must never shadow each other.
      if (table === 'memory_entries') {
        const occupied =
          destinations.get(key) ??
          (
            db
              .prepare(
                "SELECT id FROM memory_entries WHERE scope='repository' AND scope_id=? AND repository_setup_id=? AND path=? LIMIT 1",
              )
              .get(binding.repositoryId, binding.setupId, row.path) as { id: string } | undefined
          )?.id;
        if (occupied)
          conflicts.push({
            table,
            id: row.id,
            reason: 'More than one memory maps to the same repository, setup and path',
          });
        destinations.set(key, row.id);
      }
      mappings.push({
        table,
        id: row.id,
        legacyProfileName: row.scope_id,
        repositoryId: binding.repositoryId,
        setupId: binding.setupId,
        rowDigest: configurationDigest(row),
      });
    }
  }
  const report = {
    schemaVersion: 1 as const,
    profileSourceDigest: manifest.sourceDigest,
    bindingDigest: configurationDigest(manifest.bindings),
    mappings,
    retained,
    conflicts,
  };
  return { ...report, digest: configurationDigest(report) };
}

/** Called by explicit cutover on a drained database. Does not modify content, versions or provenance. */
export function applyLegacyMemoryMigration(
  db: Database.Database,
  manifest: LegacyMigrationManifest,
  expectedDigest: string,
) {
  return db.transaction(() => {
    const id = `memory-conversion-${expectedDigest}`;
    const previous = db
      .prepare('SELECT manifest FROM configuration_conversions WHERE id=?')
      .get(id) as { manifest: string } | undefined;
    if (previous) {
      const report = JSON.parse(previous.manifest) as ReturnType<
        typeof previewLegacyMemoryMigration
      >;
      const { digest, ...body } = report;
      if (
        digest !== expectedDigest ||
        configurationDigest(body) !== digest ||
        report.bindingDigest !== configurationDigest(manifest.bindings)
      )
        configurationError('Memory conversion mapping changed', 'MIGRATION_CONFLICT', 409);
      return { report, applied: false };
    }
    if (manifest.blockers.length)
      configurationError('Resolve profile conversion blockers first', 'MIGRATION_BLOCKED', 409);
    const report = previewLegacyMemoryMigration(db, manifest);
    if (report.digest !== expectedDigest)
      configurationError('Memory conversion source changed', 'CONFIG_CHANGED', 409);
    if (report.conflicts.length)
      configurationError(
        'Resolve conflicting memory paths before conversion',
        'MIGRATION_BLOCKED',
        409,
      );
    if (
      db.prepare("SELECT 1 FROM pods WHERE status NOT IN ('complete','killed') LIMIT 1").get() ||
      db
        .prepare(
          "SELECT 1 FROM managed_pods WHERE observed_exit=0 OR state NOT IN ('complete','killed') LIMIT 1",
        )
        .get()
    )
      configurationError('Drain pods before converting memory', 'MIGRATION_ACTIVE_PODS', 409);
    for (const mapping of report.mappings) {
      const config = createConfigurationStore(db).get('repository', mapping.repositoryId);
      if (!config.payload.setups.some((setup) => setup.id === mapping.setupId))
        configurationError(
          'Convert repository setups before memory',
          'MIGRATION_BINDING_MISSING',
          409,
        );
      db.prepare(
        `UPDATE ${mapping.table} SET scope='repository',scope_id=?,repository_setup_id=? WHERE id=? AND scope='profile' AND scope_id=?`,
      ).run(mapping.repositoryId, mapping.setupId, mapping.id, mapping.legacyProfileName);
    }
    db.prepare(
      'INSERT INTO configuration_conversions(id,source_digest,manifest,created_at) VALUES(?,?,?,?)',
    ).run(
      id,
      configurationDigest({ memory: report.digest }),
      JSON.stringify(report),
      new Date().toISOString(),
    );
    return { report, applied: true };
  })();
}
