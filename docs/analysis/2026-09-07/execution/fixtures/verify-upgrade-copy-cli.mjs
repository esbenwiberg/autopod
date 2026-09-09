import { parseArgs } from 'node:util';
import { verifyUpgradeCopy } from './verify-upgrade-copy.mjs';

try {
  const { values } = parseArgs({
    options: {
      snapshot: { type: 'string' },
      'snapshot-sha256': { type: 'string' },
      migrations: { type: 'string' },
      'migrations-sha256': { type: 'string' },
      scratch: { type: 'string' },
    },
  });
  if (Object.values(values).length !== 5) throw new Error('arguments_required');
  const { default: Database } = await import('better-sqlite3');
  const { runMigrations } = await import('./candidate-migrations.mjs');
  const receipt = verifyUpgradeCopy({
    Database,
    runMigrations,
    snapshot: values.snapshot,
    expectedSnapshotHash: values['snapshot-sha256'],
    migrationsDir: values.migrations,
    expectedMigrationHash: values['migrations-sha256'],
    scratchParent: values.scratch,
  });
  console.log(JSON.stringify(receipt));
  if (receipt.status !== 'isolated_upgrade_verified') process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ status: 'incomplete', phase: 'initialization' }));
  process.exitCode = 1;
}
