import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pino from 'pino';
import { reconcileNativeCheckpoint } from './reconcile-native-checkpoint.js';

try {
  const { values } = parseArgs({
    options: { input: { type: 'string' }, output: { type: 'string' } },
  });
  if (!values.input || !values.output) {
    console.error(
      'Usage: node dist/db/reconcile-native-checkpoint-cli.js --input <checkpoint-snapshot.db> --output <new-reconciled.db>',
    );
    process.exitCode = 2;
  } else {
    const receipt = await reconcileNativeCheckpoint(values.input, values.output, {
      migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
      legacyDir: fileURLToPath(new URL('./fixtures/native-reliability-151-163', import.meta.url)),
      logger: pino({ level: 'silent' }),
    });
    console.log(JSON.stringify({ status: 'verified-copy', ...receipt }));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      reason: error instanceof Error ? error.message : 'Checkpoint reconciliation failed',
    }),
  );
  process.exitCode = 1;
}
