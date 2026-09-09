# Release and remaining acceptance packet

Update: the metadata action below was approved and executed once on September 9; see [checkpoint 107](checkpoint-107.md). It identified the active DB and main release migration files. [The next verification packet](next-verification-packet.md) supersedes the fulfilled metadata approval request. Remaining pre-inspection statements below are dated September 8; deployment and paid-canary authority remain absent.

Prepared 2026-09-08. This is a reviewable proposal, not deployment authorization or a release receipt. The implementation is preserved locally; the goal remains incomplete.

## Frozen candidate and concrete diff

- Candidate source: `90a61141a6a8ed6205aae144bbb99f8c9f0f9ec5`, branch `codex/durable-execution-contract`, worktree `/private/tmp/autopod-durable-execution`.
- Compared main: `c0e5a5b4617d131257e2c448f2259b645ac351ee` (managed GitHub token support, PR 327), merged locally into the candidate. No publication was performed.
- [Exact non-documentation patch](receipts/checkpoint-106-candidate-code.diff) and [path/blob manifest](receipts/checkpoint-106-candidate-manifest.json): 384 changed non-documentation paths. This includes tests, compatibility SQL, scripts and skill handoff changes, not 384 independent production features.
- Goal SHA-256: `3dc5e753db8ec664ea8ed1a93b1150c936ea53cbc8e9f8a0def05113dfd1e481`. Original checkout work remains excluded.
- Full pipeline passed on this clean, unchanged source, 21:07:56–21:10:16 UTC. Daemon: 5,406 passed, one existing macOS platform skip. Other packages: 942 passed. Install, lint, all configured builds/type checks, tests, dependency audit and secret scan passed. Exact receipts are linked from [checkpoint 106](checkpoint-106.md).
- Final local replay on the same clean source: baseline 624.135832 ms, reuse 1,822.825459 ms, reduction -192.055890%. The 25% target is unsupported for this fixture. Both seeded defects were caught in both modes, with unchanged coverage and zero escapes. No claim of live workload improvement.
- Later packet/payload/receipt changes do not change application source. The payload has separate local tests; its proposed live execution is unrun.

The review patch uses `git diff --binary --unified=0`; its SHA-256 is recorded in the manifest. Applying it requires `git apply --unidiff-zero` against the exact base. The complete source is available at the pinned candidate commit.

## Verified target and unresolved identities

Azure control-plane read verified this VM on September 8:

`/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.Compute/virtualMachines/autopod-daemon`

Location: `swedencentral`; immutable VM ID: `3addc9bc-4812-4892-98d6-c40d5ab893c0`. [Target receipt](receipts/checkpoint-106-target.json).

Public `https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com/health` returned 200 at 21:16:35 UTC, status `ok`, version `0.0.1`, without the queried release/image/readiness fields. This is availability proof only. [Health receipt](receipts/checkpoint-106-public-health.json).

Current guest release SHA, loaded bundle bytes, active database identity/schema, exact rollback release, execution image digest, effective runtime CLI version, sandbox group/tier and registry configuration are **unverified**. The older September 7 managed-release/database observations are dated. `/opt/autopod/current` and `/data/autopod/autopod.db` are proposed inspection paths, not inferred active identities. Do not select a deployment layout from stale runbook or managed-release paths.

## Smallest next approval: bounded guest metadata

Proposed payload: [read-only-guest-inspection.py](fixtures/read-only-guest-inspection.py), version 2. SHA-256 is pinned in the candidate manifest. Execution is **not yet authorized**.

Target the exact VM resource above using the supported Azure Run Command transport. No SSH fallback. The previous attempt's extension-storage failure may still prevent Run Command; if so, report it and prepare a separately authorized repair rather than bypassing the rejected payload through another transport.

The approved scope requested is one execution, at most 60 seconds in the guest, exporting at most 64 KiB of these fields:

- Service PID/active state and release working directory restricted to `/opt/autopod/releases` or `/opt/autopod/managed/releases`; current symlink match and end-of-inspection PID stability.
- Whether a service file descriptor matches the approved `/data/autopod/autopod.db` device/inode. Only on that match: database file identity/size, schema maximum/applied count, pod count and a boolean quick-check result. An unmatched database is not queried. No row contents.
- Up to 256 migration-file names/sizes/hashes from one fixed migration directory under the actual allowed process working directory, at most 1 MiB per file and 8 MiB total. These describe files on disk, not proof of which bytes the running process loaded.
- Up to 20 recent file names/sizes/timestamps from each of the three fixed backup directories, with directory enumeration capped at 512 entries and explicit truncation. File times alone do not establish backup content freshness or intended scope.
- Capacity/available bytes for `/` and `/data/autopod`.
- At most 100 fixed SQLite/JSON/disk error classifications and bounded timestamps/endpoint categories from the last 24 hours of the service journal, limited to 10,000 lines, 2 MiB and 10 seconds. No raw log, stack, SQL identifier, row, arbitrary error message, environment or credential leaves the VM. Truncation or absence does not prove API health or root cause.

No service change, lifecycle mutation, provider call, source/backup export or new cloud resource. Estimated incremental provider/sandbox spend: **$0**. Existing VM billing continues; no new spend estimate is invented for it. Azure's command extension may use its existing operational storage, but this proposal does not repair or reprovision it. Local tests prove output bounds, task-owned command termination and sanitization; they do not prove guest execution.

Automatic approval review previously rejected the production database/backup/filesystem/sanitized-log metadata export because payload-specific egress approval was missing. This revised payload has not been retried. A general “continue” is not substituted for that approval.

## Investigation after that inspection

1. Confirm guest/process/DB identity and migration lineage. Compare current migration hashes against this candidate and main; do not infer schema from maximum version alone. Mark missing paths/permissions and truncated inventories incomplete.
2. Refresh bounded authenticated history/cost routes and correlate failing request time/category with approved error evidence. The earlier malformed-row reproductions prove local resilience, not the historical production cause. A currently healthy route disproves a claim of a current outage but does not establish the old cause.
3. If the first payload cannot isolate the failure, prepare the smallest additional schema/error metadata query supported by that result. Do not fetch raw historical rows or logs by default.
4. Discover the exact intended sandbox image digest, group/tier, runtime/provider binding and supported registry configuration before requesting the canary below. Provider credentials stay on their existing authorized paths.

## Backup verification and cutover gate

Current branches were inventoried before the final candidate: 173 remote heads, highest remote migration 152, candidate maximum 182, no missing remote objects. Native compatibility archives are separate from the active numbered migration directory. Representative upgrades, immutable retained histories, guidance acknowledgements and cleanup ownership are covered by local tests. The target database lineage still needs proof.

After active database identity is established, select one actual backup, its receipt and its intended source. Prepare a bounded, on-VM isolated restore; export only the verification verdict, checksums, source identity and completeness metadata. Keep backup data on the VM unless separately authorized. Do not copy an open WAL database as a lone file or use `immutable=1` to ignore current WAL data.

The implemented verifier is:

```text
node <candidate-release>/packages/daemon/dist/db/verify-backup-cli.js \
  --backup <approved-snapshot.db> --database <verified-active.db> --max-age-minutes 30
```

The exact paths require discovery and an approved isolated-output/data-handling scope. The verifier checks intended-source identity, receipt freshness, checksum, all-table watermarks, integrity/foreign keys and a rollback-only write probe on a private restored copy. File timestamp alone is insufficient. The cutover backup must include WAL-visible data and pass headroom admission (two copies plus 128 MiB reserve). Preserve the backup and its receipt before applying migrations. A sampled older backup can prove restore integrity without meeting the fresh-cutover requirement; label those separately.

For an identified historical native checkpoint with colliding numbering, use the copy-only reconciliation CLI only with exact proven input lineage and a new output path. It does not activate its output. Never run a speculative conversion or replace the live database automatically.

## Deployment proposal, pending later explicit authorization

Publication, target build, service restart, live mutation and any paid canary require distinct bounded session authority. No such action is requested by this packet's first metadata approval.

1. Resolve the actual live release/layout and rollback source; record runtime/image identities, target DB and verified fresh pre-cutover backup. Reconcile task-owned worker/cleanup claims with trustworthy resource identity and observed termination. Elapsed time, restart, unknown cloud status and a guessed PID are insufficient.
2. Refresh main and migration inventory immediately before publication. If source changes, integrate the supported change locally and repeat affected/full verification on the resulting source. Publish only the exact approved branch/source after explicit authorization; the hosted VM cannot clone this unpublished local candidate.
3. Confirm no restart-blocking pods through the existing daemon drain and API/DB safeguards. Do not disable them, use `--force`, or interrupt live work without approval naming the affected work. Retain source and outstanding human decisions.
4. Use the hosted deployment skill and existing script only after verifying that its conventional release layout matches the current host. If it does not, prepare the supported managed rollout procedure before asking to execute. Dependencies/layout drift or unknown old source require a full build.
5. Conventional-layout command, **template only until those gates are satisfied**:

```text
scripts/deploy-hosted-daemon.sh --target 90a61141a6a8ed6205aae144bbb99f8c9f0f9ec5 \
  --full --verify-string 'Worker admission requires its current durable execution claim'
```

That exact marker was found in this candidate's built `packages/daemon/dist/index.js`. It is a semantic guard, not proof of every emitted chunk; retain the full built artifact manifest with release identity. Keep browser dependency/Chromium prewarm and launch checks enabled. Capture `PLAYWRIGHT_PREWARM_OK`, service status, bounded local/external health and post-start release evidence. Check migration status and healthy bounded history/cost routes without asserting that status 200 proves all historical data correct.

## Rollback procedure and stop conditions

Stop rollout on unknown database lineage, failed fresh backup/restore or headroom, active/unresolved ownership, build/prewarm failure, identity mismatch or failed health/behavior. Before cutover, leave the old service/source/DB untouched.

After cutover, **a symlink-only rollback is not safe by default**. Schema 177–182 adds retained history and durable guidance/worker/cleanup rules that older writers do not honor. First preserve the post-cutover database/WAL and source, stop further task admission using the approved drain procedure, and establish observed worker/cleanup settlement. Prefer a forward correction retaining the new records when binary downgrade compatibility is unknown.

Only a separately approved, verified rollback can restore the recorded old release with its compatible database. Preserve and reconcile post-cutover work, deliveries and human decisions before any database replacement; never silently discard them. Keep both pre- and post-cutover snapshots. The old SHA/path is currently unknown, so no executable guessed rollback command is supplied. Once identified and compatibility proved, the existing conventional-layout script's `--rollback <verified-old-sha>` supplies the service swap/restart; it does not by itself solve database/data reconciliation.

## Required actual-image capability canary

Not executed and not yet ready for spend approval: exact image digest, sandbox group, tier, provider/account configuration and tariff remain unknown. Do not substitute a local container for this criterion or launch a coding task simply to discover capability.

Proposed minimum envelope after discovery: one disposable sandbox on the intended image digest, no agent/provider invocation, one attempt, at most five minutes active time, and cleanup restricted to that exact created sandbox with observed terminal removal. Record resource/tier/image identity at creation; incomplete cleanup is an outstanding resource, not a successful receipt. The following checks use task-owned temporary paths and the actual backend's upload/exec APIs:

- Capture effective exec user, actual selected runtime CLI path/version and granted memory/CPU/streaming capability.
- Exercise `runtimeConfigInstallCommand` using a non-secret sentinel uploaded through the actual API: effective-user readability, write permission, atomic replacement and readable final file. A denied configuration capability must fail before a coding agent can start; do not grant extra ownership privileges to make the check green.
- For the identified .NET image/feed requirement, check `dotnet nuget list source --configfile <canary-config>`, `dotnet package search --help` for the required flags, then the bounded `dotnet package search __autopod_auth_probe__ --configfile <canary-config> --take 1 --format json`. Use only the explicitly approved feed/auth scope; omit credential-bearing output. Unsupported SDK, incomplete results, connectivity failure and 401/403 remain distinct failures.
- Return a small success/failure receipt with capabilities and exact image/CLI/daemon/contract identities. Do not run a paid model, create a repair PR or widen the task.

Spend estimate must be filled after discovery: billed tier rate × rounded allocation duration (up to five minutes) plus any explicitly priced image/storage/egress charges. No dollar figure is claimed while these inputs are unavailable. Request the exact target and maximum charge before execution. A paid validation benchmark or scheduled judgment cohort is not required to turn the negative local benchmark positive and is not included.

## Supported operator acceptance still required

CLI HTTP command tests and actual built mobile fixture interactions are retained in the ledger. Native decoding, mapping, request and build tests passed on their recorded commits, but native UI interaction remains unverified because native computer-control APIs are unavailable in this session.

Use the candidate native app against a task-owned local fixture (not production) for visible acceptance: unresolved/late human decisions; guidance pending versus acknowledged; source-preservation and finalization stages; validation-only Resume versus authorized worker Rework; unchanged retry denial and explicit binding authorization; unavailable/overlapping duration and stored cost completeness; skipped/waived/unresolved/delivery dispositions; retained deleted history without live actions; strict dispatch rerun confirmation; exact-window scan report and human-selected repair; release/readiness and restart ownership hints. Observe the actual rendered values/actions and request outcomes, saving named screenshots/receipts. No physical-device criterion is added.

A supported native interaction facility or a user-performed visible walkthrough with results is the remaining prerequisite for this surface. Compilation is not substituted. Any follow-up defect should be reproduced and corrected before promoting the affected acceptance entry.
