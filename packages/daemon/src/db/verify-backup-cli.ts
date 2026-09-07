import { parseArgs } from 'node:util';
import { databaseIdentity, verifyBackupRestore } from './backup-verification.js';

const { values } = parseArgs({
  options: {
    backup: { type: 'string' },
    database: { type: 'string' },
    'max-age-minutes': { type: 'string', default: '30' },
  },
});
if (!values.backup || !values.database) {
  console.error(
    'Usage: node dist/db/verify-backup-cli.js --backup <snapshot.db> --database <intended-active.db> [--max-age-minutes 30]',
  );
  process.exitCode = 2;
} else {
  try {
    const receipt = await verifyBackupRestore(values.backup, {
      expectedSourceIdentity: databaseIdentity(values.database),
      maxAgeMs: Number(values['max-age-minutes']) * 60_000,
    });
    console.log(JSON.stringify({ status: 'verified', ...receipt }));
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'failed',
        reason: error instanceof Error ? error.message : 'Restore verification failed',
      }),
    );
    process.exitCode = 1;
  }
}
