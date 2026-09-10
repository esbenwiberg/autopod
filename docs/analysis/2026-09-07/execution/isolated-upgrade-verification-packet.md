# Isolated hosted snapshot upgrade: verified

Checkpoint 124 executed the explicitly approved checkpoint-123 packet once and verified the exact hosted schema-153 snapshot upgrade to candidate schema 183, retained data, input immutability and both private-directory cleanups. [Verified result](receipts/checkpoint-124-hosted-result.json), [invocation identity](receipts/checkpoint-124-invocation-identity.json). No active database migration or service restart occurred. No further approval is pending for this completed action.

The earlier checkpoint-122 invocation refused changed inputs at checkpoint 123. That failure remains recorded separately. The exact successful procedure below is retained as evidence; it is not a standing authorization to rerun against later snapshots.

## Exact source and input

Application source: `4e73cd8ce88e44cdb5c2d8d0a89447b819fa5a39`. The [package manifest](receipts/checkpoint-123-upgrade-package.json) pins every bundled source input and generated helper hash. Migration set SHA-256: `0413c2b3502ce14cf74d164ac6fc474b91143101fd8599d4fea27c91ebb733bf`. The build bundles the actual `runMigrations` entry point and its backup helpers, without starting the daemon. Native `better-sqlite3` is external; target-host loading and ABI compatibility must pass before execution. No dependency installation is authorized.

Target remains the pinned `autopod-daemon` VM in the current release packet. Require service cwd `/opt/autopod/releases/ca92847a/packages/daemon`; the old `c0e5a5b4` cwd is superseded. Verified snapshot was `/data/autopod/backups/1788982545717.db`, 877,150,208 bytes, SHA-256 `126489a4fdc690888999dd487677774e000be00ba878b93e087d9e36c8fb28fc`. Checkpoint 123 observed its stable file/hash identity, no WAL/journal, single link and schema maximum 153. The service still holds the intended active database inode. Candidate compatibility is now verified for this exact snapshot. Freshness against current active row watermarks at a future cutover remains separate. Revalidate target and exact snapshot identity immediately before use. If it changed, refuse and prepare a new identity. This dated snapshot is not a fresh cutover backup.

## Local reproduction

From the worktree root, using installed dependencies:

```sh
node docs/analysis/2026-09-07/execution/fixtures/package-upgrade-check.mjs /private/tmp/autopod-upgrade-next
ln -s /private/tmp/autopod-durable-execution/packages/daemon/node_modules /private/tmp/autopod-upgrade-next/node_modules
CANDIDATE_MIGRATION_BUNDLE=/private/tmp/autopod-upgrade-next/candidate-migrations.mjs node --test docs/analysis/2026-09-07/execution/fixtures/verify-upgrade-copy.test.mjs
```

Use a new output directory; existing outputs are refused. The symlink is only for local dependency resolution and is never an artifact to upload. Package only the three manifest-listed JavaScript artifacts, migration directory and manifest. Verify all hashes after any transfer.

Eleven local cases passed, including actual migration of synthetic managed-152 and managed-153 snapshots, original-column/row preservation, task-membership backfill, integrity and foreign keys; refusal of wrong snapshot/migration hashes and WAL-bearing input; detection of seeded retained-data loss; redaction of raw migration errors; and the real packaged CLI success/refusal path. [Receipt](receipts/checkpoint-123-copy-tests.txt). These are local synthetic proofs.

## Executed on-VM sequence and acceptance

1. Read the pinned VM/service and backup identities, and require the approved snapshot hash. Check the existing Node/native SQLite combination in memory only. Record bounded Node/SQLite/module-version and artifact hashes; do not import the daemon entry point or install dependencies.
2. Upload the hash-pinned source-only package into one newly created mode-0700 directory under `/data/autopod`. Link only the verified existing SQLite dependency into that private package. Keep all databases on the VM. No service restart, active-database migration, credentials export or provider work is part of this scope.
3. Require at least three snapshot sizes plus 256 MiB available on the scratch filesystem. Copy into a new private directory with an exclusive output filename and verify the checksum before SQLite opens the copy. Refuse symlink/hardlinked or WAL/journal-bearing snapshots and any initial schema other than the explicitly pinned managed 153.
4. Run the packaged CLI under an external 300-second watchdog with a 256 MiB Node heap. The helper's 240-second checks do not interrupt an individual synchronous SQLite call; the external watchdog and outer cleanup are mandatory. The pinned invocation arguments are the snapshot above, its hash, the package migration directory/hash, and the private scratch parent. Never substitute the active database path.
5. Require schema 183; compare a count and SHA-256 multiset of every original table's original columns before and after migration; require task backfill for every pod, integrity/foreign keys and a rolled-back write probe. Recheck unchanged input identity/hash and migration bytes. Return only the bounded JSON verdict, hashes, versions and boolean checks. No raw rows, errors, SQL, stack traces, credentials or database bytes leave the VM.
6. On success, failure or timeout, stop only the task-owned verifier, observe exit, remove only its exact private directory and verify removal. Do not use a wildcard cleanup or touch the active DB/WAL, existing backup, service, worktrees or pods. A cleanup failure is incomplete acceptance and requires its exact retained path to be reconciled.

No additional cloud resource or model call was used. The existing VM performed bounded disk/CPU work, with a maximum five-minute verification process and scratch headroom described above; this is not an actual-image paid canary. The exact source package and wrapper hashes are recorded in the transport manifest. The host confirmed Node 22.23.1 and resolved its compatible existing SQLite dependency inside the pinned release before copying/upgrading; its bounded module version/hash is in the result. Nothing was installed or silently substituted. Unknown prerequisites cause refusal, not fallback installation or alternate credentials.

The successful result closes compatibility for this specific historical active-database snapshot only. It does not prove loaded daemon bytes, future cutover freshness, rollback compatibility with post-cutover decisions, live API causality or sandbox capability. Those remain separate requirements.

## Exact approved action executed at checkpoint 124

The user approved the [83,252-byte source script](receipts/checkpoint-123-hosted-upgrade.sh), SHA-256 `0dd19a717659507fe274a508a9759adb0008cbf481b09b5d95feb0919028622a`, against the VM and historical snapshot pinned above. The [manifest](receipts/checkpoint-123-transport-manifest.json) records all bounds and target identities. Ten local [wrapper tests](receipts/checkpoint-123-wrapper-tests.txt) and eleven [candidate-copy tests](receipts/checkpoint-123-copy-tests.txt) pass; [local host refusal](receipts/checkpoint-123-local-refusal.json) confirms the executable refuses an unsupported host.

The executed invocation re-read the Azure VM immutable ID and required `3addc9bc-4812-4892-98d6-c40d5ab893c0`; then invoked this exact script once with `az vm run-command invoke`, `RunShellScript`, on the full pinned VM resource ID. The prepared local command file is `/private/tmp/autopod-upgrade-transport-123/invoke-after-approval.sh`; it checks VM identity before invocation. Verify its hash and the script hash against the manifest first. No automatic retry after an ambiguous response: inspect the specific operation and reconcile any reported private cleanup path.

The source upload is 52,352 compressed bytes embedded in the script. Run Command may retain nonsecret script source in Azure operation records. The operation uses existing VM CPU/disk for up to seven minutes overall (candidate child up to five minutes), requires more than 2,899,886,080 bytes available scratch, and allocates no new cloud compute resources or paid model/sandbox calls. Existing VM/storage metering continues; this is not a claim of zero total infrastructure cost or an I/O billing cap. Source and databases stay on the VM except the bounded verdict/provenance output. No service restart, active database upgrade, deployment or publication is included.
