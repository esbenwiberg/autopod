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
    require('better-sqlite3');
    return false;
  } catch {
    console.warn(
      '\n⚠  better-sqlite3 native bindings not available — skipping DB tests.\n' +
        '   Run `npx node-gyp rebuild` in the better-sqlite3 package to fix, ' +
        'or set SKIP_DB_TESTS=0 to force-include them.\n',
    );
    return true;
  }
}

const dbTestPatterns = [
  'src/integration.test.ts',
  'src/e2e.test.ts',
  'src/routes-extended.test.ts',
  'src/sessions/session-manager.test.ts',
  'src/sessions/session-repository.test.ts',
  'src/sessions/session-lifecycle.e2e.test.ts',
  'src/sessions/escalation-repository.test.ts',
  'src/sessions/event-repository.test.ts',
  'src/sessions/validation-repository.test.ts',
  'src/sessions/local-reconciler.test.ts',
  'src/profiles/profile-store.test.ts',
  'src/actions/action-integration.test.ts',
  'src/actions/audit-repository.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    exclude: [
      '**/node_modules/**',
      ...(shouldSkipDbTests() ? dbTestPatterns : []),
    ],
  },
});
