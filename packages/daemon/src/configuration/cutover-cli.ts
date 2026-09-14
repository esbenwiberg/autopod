import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pino from 'pino';
import {
  applyOfflineConfigurationCutover,
  restoreConfigurationCutoverCandidate,
} from './configuration-cutover.js';
import { conversionBindingsSchema } from './conversion-bindings.js';

const { values } = parseArgs({
  options: {
    operation: { type: 'string' },
    database: { type: 'string' },
    'secrets-key': { type: 'string' },
    'source-identity': { type: 'string' },
    'source-fingerprint': { type: 'string' },
    'conversion-digest': { type: 'string' },
    bindings: { type: 'string' },
    owner: { type: 'string' },
    'output-directory': { type: 'string' },
  },
});
if (
  !values.database ||
  !values['secrets-key'] ||
  !values['conversion-digest'] ||
  !['apply-reviewed', 'restore-candidate'].includes(values.operation ?? '')
) {
  console.error(
    'Stop the daemon first. Use --operation apply-reviewed --database DB --secrets-key KEY --source-identity ID --source-fingerprint HASH --conversion-digest DIGEST --owner OWNER [--bindings JSON]. Or --operation restore-candidate --database DB --secrets-key KEY --conversion-digest DIGEST --output-directory DIR. Rehearse and review with conversion-cli before applying.',
  );
  process.exitCode = 2;
} else {
  try {
    if (values.operation === 'restore-candidate') {
      if (!values['output-directory']) throw new Error('Output directory required');
      const result = await restoreConfigurationCutoverCandidate({
        databasePath: values.database,
        keyPath: values['secrets-key'],
        expectedConversionDigest: values['conversion-digest'],
        outputDirectory: values['output-directory'],
      });
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (!values['source-identity'] || !values['source-fingerprint'] || !values.owner)
        throw new Error('Reviewed identity and owner required');
      const here = dirname(fileURLToPath(import.meta.url));
      const migrationsDirectory = [
        join(here, '..', 'db', 'migrations'),
        join(here, '..', '..', 'src', 'db', 'migrations'),
      ].find(existsSync);
      if (!migrationsDirectory) throw new Error('Migrations unavailable');
      const result = await applyOfflineConfigurationCutover({
        databasePath: values.database,
        keyPath: values['secrets-key'],
        expectedSourceIdentity: values['source-identity'],
        expectedSourceFingerprint: values['source-fingerprint'],
        expectedConversionDigest: values['conversion-digest'],
        ownerUserId: values.owner,
        bindings: conversionBindingsSchema.parse(
          values.bindings ? JSON.parse(readFileSync(values.bindings, 'utf8')) : {},
        ),
        migrationsDirectory,
        logger: pino({ level: 'silent' }),
      });
      console.log(JSON.stringify(result, null, 2));
    }
  } catch {
    // Source/decryption errors may contain credentials. Preserve backups and avoid raw diagnostics.
    console.error(
      'Cutover operation failed. Keep the daemon stopped and retain the verified backups. Check the reviewed identities, drain state, key and conversion mappings. No admission was enabled and no live restore was performed.',
    );
    process.exitCode = 1;
  }
}
