import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pino from 'pino';
import { loadExistingKey } from '../crypto/credentials-cipher.js';
import { conversionBindingsSchema } from './conversion-bindings.js';
import { rehearseConfigurationConversion } from './conversion-rehearsal.js';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    'output-directory': { type: 'string' },
    'secrets-key': { type: 'string' },
    bindings: { type: 'string' },
    owner: { type: 'string' },
    'expected-digest': { type: 'string' },
  },
});
if (!values.source || !values['output-directory'] || !values['secrets-key'] || !values.owner) {
  console.error(
    'Usage: node dist/configuration/conversion-cli.js --source <database.db> --output-directory <existing-directory> --secrets-key <original-key> --owner <operator-id> [--bindings <mapping.json>] [--expected-digest <reviewed-digest>]',
  );
  process.exitCode = 2;
} else {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationsDirectory = [
      join(here, '..', 'db', 'migrations'),
      join(here, '..', '..', 'src', 'db', 'migrations'),
    ].find(existsSync);
    if (!migrationsDirectory) throw new Error('Migrations unavailable');
    const result = await rehearseConfigurationConversion({
      source: values.source,
      outputDirectory: values['output-directory'],
      cipher: loadExistingKey(values['secrets-key']),
      ownerUserId: values.owner,
      bindings: conversionBindingsSchema.parse(
        values.bindings ? JSON.parse(readFileSync(values.bindings, 'utf8')) : {},
      ),
      expectedDigest: values['expected-digest'],
      migrationsDirectory,
      logger: pino({ level: 'silent' }),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.preview.blocked) process.exitCode = 3;
  } catch {
    // Decoder/provider errors can contain raw source values. Do not echo them from this entry point.
    console.error(
      'Configuration rehearsal failed. Check the original key, mapping file, migration lineage and reviewed digest. The source database was not converted.',
    );
    process.exitCode = 1;
  }
}
