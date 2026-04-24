import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// Auto-detect whether better-sqlite3 native bindings are available.
// When they aren't (common in dev without a full native rebuild), DB-dependent
// tests are excluded so the rest of the suite still runs.
// Override with SKIP_DB_TESTS=1 (force skip) or SKIP_DB_TESTS=0 (force include).
function shouldSkipDbTests(): boolean {
  const env = process.env.SKIP_DB_TESTS;
  if (env === '1') return true;
  if (env === '0') return false;

  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    // Actually open a database — require() alone can succeed even when the
    // native binding is missing or broken at runtime (e.g. wrong arch,
    // pnpm virtual-store rebuild quirks).
    const db = new Database(':memory:');
    db.close();
    return false;
  } catch {
    console.warn(
      '\n⚠  better-sqlite3 native bindings not available — skipping DB tests.\n' +
        '   Run `npm rebuild better-sqlite3` or `npx pnpm rebuild better-sqlite3` to fix, ' +
        'or set SKIP_DB_TESTS=0 to force-include them.\n',
    );
    return true;
  }
}

const dbTestPatterns = [
  '**/integration.test.ts',
  '**/e2e.test.ts',
  '**/routes-extended.test.ts',
  '**/session-manager.test.ts',
  '**/session-repository.test.ts',
  '**/session-lifecycle.e2e.test.ts',
  '**/escalation-repository.test.ts',
  '**/event-repository.test.ts',
  '**/validation-repository.test.ts',
  '**/local-reconciler.test.ts',
  '**/profile-store.test.ts',
  '**/action-integration.test.ts',
  '**/audit-repository.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    exclude: [
      '**/node_modules/**',
      '**/.autopod-data/**',
      ...(shouldSkipDbTests() ? dbTestPatterns : []),
    ],
  },
});
