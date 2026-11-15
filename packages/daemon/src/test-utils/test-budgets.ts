/**
 * Explicit deadlines for tests that are long by construction. The 5 s Vitest default stays the
 * global budget; do not raise it, and do not add retries.
 *
 * Use INTEGRATION_TEST_TIMEOUT_MS only when a test needs at least ~40% of the default unloaded
 * because it drives real Git repositories, real child processes or production timers/deadlines,
 * or builds a production-scale fixture. Full-suite pod validations (8 GB / 2 CPU, shared Docker
 * overlay disk) ran such tests up to 2x slower than a local run and showed transient host stalls
 * that ran consecutive ~1 s real-Git tests at ~5x. Prefer making the test cheaper first: on-disk
 * SQLite goes through test-utils/disk-database.ts, and in-memory fixtures copy a migrated template.
 *
 * State the budget per test (`it(name, fn, INTEGRATION_TEST_TIMEOUT_MS)`) or, when the whole file
 * is built on such a fixture, once per file with a comment:
 * `vi.setConfig({ testTimeout: INTEGRATION_TEST_TIMEOUT_MS })` (scoped to that test file).
 */
export const INTEGRATION_TEST_TIMEOUT_MS = 15_000;
