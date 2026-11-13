#!/usr/bin/env node
// Canonical copy lives in shared; SwiftPM bundles this generated resource.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

for (const name of ['failover', 'validation', 'instructions', 'settings']) {
  const source = new URL(`../packages/shared/src/configuration-help/${name}.json`, import.meta.url);
  const target = new URL(
    `../packages/desktop/Sources/AutopodUI/Resources/ConfigurationHelp/${name}.json`,
    import.meta.url,
  );
  const content = readFileSync(source, 'utf8');
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== content) {
      throw new Error(
        'Configuration help is out of sync. Run node scripts/sync-configuration-help.mjs',
      );
    }
  } else {
    mkdirSync(new URL('.', target), { recursive: true });
    writeFileSync(target, content);
  }
}
