# R08a: qualify historical upgrade through its actual backup

## Overview and authorization

Add one durable integration scenario connecting existing upgrade/backup/restore
checks. The autonomous reliability campaign authorizes all phases, worker execution,
review and a PR into codex/reliability. No product behavior or UI changes.

## Current state and desired result

Research: ../research/2026-10-15-upgrade-restore-qualification.md.
The existing native182 fixture upgrades through real cutovers, but its generated
backup has not been joined to a restored-copy re-upgrade in one test. Prove that
known historical pod/guidance data survives both paths, the historical backup
remains immutable, and a newer original database is unaffected by restore proof.
This is one historical fixture, not a supported-version matrix or power-loss test.

## Scope and approach

Create packages/daemon/src/db/upgrade-restore-roundtrip.test.ts. Follow the
historical182 fixture in managed-migration-compatibility.test.ts: copy current SQL
through182 except153 into an owned temporary migration directory, run the actual
runner on an empty disk DB and seed synthetic retained pod/guidance data. Use no
live DB, key, auth, runtime, provider or daemon process. Do not change production
migration/backup code unless a reproduced contradiction is reported to root.

Create explicit owned backups directories next to each active/restored DB before
calling the production runner so ancestor backup discovery cannot escape the test
root. Enable WAL with autocheckpoint off, checkpoint initial schema, then commit
retained fixture rows; assert a nonempty WAL exists before the first upgrade.

## Phase1: actual upgrade and generated backup

- Capture original schema version, retained pod projection and guidance rows.
- Run runMigrationsWithBackups against the full current migration directory.
- Assert current maximum migration version, repaired migration153/table, retained
  pod task/summary/source fields and exact guidance rows; integrity/FKs pass.
- Discover actual generated receipts from the fixture-owned backup directory;
  require the expected pending cutover suffixes193/194/198/200, paired DB/receipt,
  source identity derived from original active path (never trust receipt alone).
- Verify every generated backup using verifyBackupRestore. Open readonly and prove
  schema182, retained pod/guidance payloads and the committed WAL row are present.
  Record backup+receipt hashes before later work. Do not mutate a backup in place.

## Phase2: restore copy, re-upgrade, and isolation

Add a distinct post-upgrade marker row to the original active DB, then capture its
relevant rows/schema versions. Copy one verified historical backup to a second
owned path; use its own backups directory and open it with production SQLite
settings. Run the same full migration chain, assert repaired153 and currentversion,
matching retained pod/guidance content, integrity/FKs and absence of the original's
post-upgrade marker. Compare schema SQL and version numbers to the original;
do not compare incidental migration timestamps or generated conversion identities
as if they were a semantic contract. Rerun the runner on the restored copy to prove
idempotence. Close/reopen that copy and recheck persisted retained state.

Assert original post-upgrade rows/schema remain unchanged by verification and
restored-copy work. Verify all historical backup+receipt hashes remain unchanged.
Close every connection in finally and remove only the owned root. Bound tests and
any subprocesses; no sleeps for ordering. Existing built verify-backup CLI checks
run in the broader qualification set; this new scenario need not duplicate them.

## Phase3: qualification, review and integration

Use Node22/pnpm9.15.4, frozen install, fresh daemon dependency build. Run new test
then existing migrate, managed-migration-compatibility, backup, cutover-backup,
reconcile-native-checkpoint, completion-journal, retained-history-upgrade,
configuration-cutover and conversion-cli suites with SKIP_DB_TESTS=0. Run supported
typecheck, scoped Biome, secret scan and diffcheck. A test-only change does not
require another unrelated full daemon suite after these affected checks pass.

Record exact revision/commands/counts/skips and observable assertions. Root or an
independent worker reviews and reruns the new boundary before PR creation. Wait
for hosted checks, merge only into campaign and rerun the integrated scenario.
No human manual verification is needed for this disposable data contract.

## Acceptance

- [x] Production upgrade generates verified historical snapshots with WAL payload.
- [x] Separate restored copy upgrades and reopens with retained data/current schema.
- [x] Original newer data and backup/receipt bytes remain unchanged.
- [x] Idempotence, integrity/FKs, cleanup and broader qualification pass.
- [ ] Independent pre-PR review, hosted and integrated proof recorded.

## Compatibility, performance and rollback

Tests only, no schema/API/dependency change. One small historical database and its
cutover copies add disk/fsync work; use generous functional deadlines and report
runtime without treating it as a performance benchmark. Revert the test to remove
this additional qualification; no production rollback action exists.

## Status

Root plan independently reviewed by research_cli without blockers. Worker
implementation and automated qualification completed under standing authorization;
independent final review is next. Report any fixture assumption mismatch before
expanding production scope. No open product choices.


## Implementation and proof

Worker branch `codex/reliability-upgrade-proof` starts at
`984bc2c435e43a4da48be45f05f34ac437bca987`. Only the new test and this plan changed.
The final commit identifier and source hashes are in the worker handoff and ignored
`.autopod-data/reliability/r08a/proof.json`, avoiding a self-referential commit ID.

The test uses the actual migration runner and production SQLite settings on a
private schema182 database with migration153 absent. Initial schema is checkpointed,
a retained pod/source projection and guidance row are committed afterwards, and
nonempty WAL is asserted before upgrade. All four pending cutovers produce paired
snapshots/receipts under a pre-created fixture-owned backup directory. Each receipt
is checked against identity derived from the active path, verified in isolation,
and its exact historical schema versions, pod/source fields and WAL guidance read.

One verified snapshot is copied to another owned database, upgraded through the
same full chain, compared to the first upgraded schema/version numbers, rerun
idempotently and closed/reopened. A newer guidance row added only to the original
remains there and is absent from the restored copy. Original pod/guidance/schema/
version rows and all historical backup/receipt hashes remain unchanged. Both
backup directories are private and all connections/files are disposed in finally;
the test also asserts its root was removed on success.

The initial run failed only an extra directory-equality assertion: SQLite opened
a WAL-mode backup readonly and created WAL/SHM sidecars. Root confirmed the
fixture adjustment fits the plan: readonly payload inspection now uses disposable
copies whose SHA256 matches the actual backup. This keeps the actual backup
directory untouched and retains the exact directory/hash assertions. This was not
production corruption or a production fix. The initial output remains in
`initial-readonly-sidecars.log`.

All commands below use Node22.23.3/pnpm9.15.4 through:

```sh
npx -y -p node@22 -p pnpm@9.15.4 -c '<command>'
```

Executed checks:

- `pnpm install --frozen-lockfile && pnpm --filter @autopod/daemon... build`
  passed (`setup-build.log`), including a fresh build of the offline CLI binaries.
- `SKIP_DB_TESTS=0 pnpm --filter @autopod/daemon exec vitest run src/db/upgrade-restore-roundtrip.test.ts --reporter=verbose`
  passed: one test, 391ms test time / 675ms run time (`roundtrip.log`). These are
  observed functional timings, not performance thresholds.
- `SKIP_DB_TESTS=0 pnpm --filter @autopod/daemon exec vitest run src/db/upgrade-restore-roundtrip.test.ts src/db/migrate.test.ts src/db/managed-migration-compatibility.test.ts src/db/backup.test.ts src/db/cutover-backup.test.ts src/db/reconcile-native-checkpoint.test.ts src/pods/completion-journal.test.ts src/pods/retained-history-upgrade.test.ts src/configuration/configuration-cutover.test.ts src/configuration/conversion-cli.test.ts`
  passed: 10 files, 67 tests, no skips, 14.78 seconds (`qualification.log`). Existing
  built backup-verification, reconciliation and conversion CLI checks executed.
- `pnpm --filter @autopod/daemon typecheck && pnpm exec biome check packages/daemon/src/db/upgrade-restore-roundtrip.test.ts && pnpm secret-scan`
  passed (`static.log`). Typecheck is the supported tsup declaration check.
- `git diff --check` passed.

Verdict: **PROVEN** for this disposable historical round trip. No production
behavior, migrations, dependencies, credentials, provider/container execution or UI
changed. No live database was read. This does not establish a historical release
support matrix, power-loss durability, client compatibility or performance target.
The plan deliberately requires the affected qualification set rather than an
additional unrelated full daemon run. Independent pre-PR review and hosted/
integrated checks remain coordinator-owned and unchecked.
