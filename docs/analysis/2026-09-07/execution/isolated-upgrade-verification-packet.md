# Isolated hosted snapshot upgrade: prepared local verifier

This is a scoped preparation artifact, not deployment authority or hosted acceptance. The executable verifier and packaging script are locally tested; the final hosted transport/watchdog wrapper still needs to be sealed and reviewed before asking for execution approval. No database or source artifact has been uploaded.

## Exact source and input

Application source: `f93dd4d9a66bcf0a4ad174d0efc378d931239faf`. The [package manifest](receipts/checkpoint-116-upgrade-package.json) pins every bundled source input and generated helper hash. Migration set SHA-256: `42a8de63d87b6096c7cabec6b0273c673d3a96c894108853d88acf5fe02da8f7`. The build bundles the actual `runMigrations` entry point and its backup helpers, without starting the daemon. Native `better-sqlite3` is external; target-host loading and ABI compatibility must pass before execution. No dependency installation is authorized.

Target remains the pinned `autopod-daemon` VM in the current release packet. Proposed snapshot is the already inspected `/data/autopod/backups/1788930281287.db`, 877,150,208 bytes, SHA-256 `3624d3be6ef845f4dded1b84be7bbe38891ca9d3b469c43db166e4dcdd473c68`. It was compared with the intended active database at checkpoint 108. Revalidate target and exact snapshot identity immediately before use. If it changed, refuse and prepare a new identity. This dated snapshot is not a fresh cutover backup.

## Local reproduction

From the worktree root, using installed dependencies:

```sh
node docs/analysis/2026-09-07/execution/fixtures/package-upgrade-check.mjs /private/tmp/autopod-upgrade-next
ln -s /private/tmp/autopod-durable-execution/packages/daemon/node_modules /private/tmp/autopod-upgrade-next/node_modules
CANDIDATE_MIGRATION_BUNDLE=/private/tmp/autopod-upgrade-next/candidate-migrations.mjs node --test docs/analysis/2026-09-07/execution/fixtures/verify-upgrade-copy.test.mjs
```

Use a new output directory; existing outputs are refused. The symlink is only for local dependency resolution and is never an artifact to upload. Package only the three manifest-listed JavaScript artifacts, migration directory and manifest. Verify all hashes after any transfer.

Eight local cases passed, including actual migration of a synthetic managed-152 snapshot, original-column/row preservation, task-membership backfill, integrity and foreign keys; refusal of wrong snapshot/migration hashes and WAL-bearing input; detection of seeded retained-data loss; redaction of raw migration errors; and the real packaged CLI success/refusal path. [Receipt](receipts/checkpoint-116-upgrade-tests.txt). These are local synthetic proofs.

## Proposed on-VM sequence and acceptance

1. Read the pinned VM/service and backup identities, and require the approved snapshot hash. Check the existing Node/native SQLite combination in memory only. Record bounded Node/SQLite/module-version and artifact hashes; do not import the daemon entry point or install dependencies.
2. Upload the hash-pinned source-only package into one newly created mode-0700 directory under `/data/autopod`. Link only the verified existing SQLite dependency into that private package. Keep all databases on the VM. No service restart, active-database migration, credentials export or provider work is part of this scope.
3. Require at least three snapshot sizes plus 256 MiB available on the scratch filesystem. Copy into a new private directory with an exclusive output filename and verify the checksum before SQLite opens the copy. Refuse symlink/hardlinked or WAL/journal-bearing snapshots and any initial schema other than managed 152.
4. Run the packaged CLI under an external 300-second watchdog with a 256 MiB Node heap. The helper's 240-second checks do not interrupt an individual synchronous SQLite call; the external watchdog and outer cleanup are mandatory. The pinned invocation arguments are the snapshot above, its hash, the package migration directory/hash, and the private scratch parent. Never substitute the active database path.
5. Require schema 182; compare a count and SHA-256 multiset of every original table's original columns before and after migration; require task backfill for every pod, integrity/foreign keys and a rolled-back write probe. Recheck unchanged input identity/hash and migration bytes. Return only the bounded JSON verdict, hashes, versions and boolean checks. No raw rows, errors, SQL, stack traces, credentials or database bytes leave the VM.
6. On success, failure or timeout, stop only the task-owned verifier, observe exit, remove only its exact private directory and verify removal. Do not use a wildcard cleanup or touch the active DB/WAL, existing backup, service, worktrees or pods. A cleanup failure is incomplete acceptance and requires its exact retained path to be reconciled.

No additional cloud resource or model call is proposed. The existing VM would perform bounded disk/CPU work, with a maximum five-minute verification process and scratch headroom described above; this is not an actual-image paid canary. Final transport size, existing module identity, watchdog availability, cleanup code and command hashes must be recorded in the executable approval payload before hosted execution. Unknown prerequisites cause refusal, not fallback installation or alternate credentials.

A successful result would close compatibility for this specific historical active-database snapshot only. It would not prove loaded daemon bytes, future cutover freshness, rollback compatibility with post-cutover decisions, live API causality or sandbox capability. Those remain separate requirements.
