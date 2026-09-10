# Release and remaining acceptance packet

**CP127 update:** approved CP126 import returned HTTP 401; no sandbox ran and repeated inventories found no task resources. The [corrected additional-attempt packet](corrected-image-canary-packet.md) adds the documented transient ACR token exchange and requires separate approval. Earlier statements that execution was unapproved are dated CP126 history.

Updated September 10, checkpoint 126. This packet supersedes the dated approval requests in checkpoints 106–123. Their raw receipts remain retained. It is a local review artifact; it does not authorize publication, deployment, restart, cloud access changes or a paid canary. The goal remains incomplete.

## Current tested candidate

- Application source: `4e73cd8ce88e44cdb5c2d8d0a89447b819fa5a39`, isolated branch `codex/durable-execution-contract` at `/private/tmp/autopod-durable-execution`.
- [Current non-documentation patch](receipts/checkpoint-122-candidate-code.diff) and [base/candidate blob manifest](receipts/checkpoint-122-candidate-manifest.json) compare against freshly fetched main `b75fbf0b7e2c4ea455838a6e4df6537665a7a8cc`, integrated locally. The patch uses `--binary --unified=0`; applying it requires the exact base and `git apply --unidiff-zero`. Recheck main before publication.
- Governing contract SHA-256: `3dc5e753db8ec664ea8ed1a93b1150c936ea53cbc8e9f8a0def05113dfd1e481`; unchanged from the original checkout. Unrelated original checkout changes remain excluded.
- [Clean full pipeline](receipts/checkpoint-122-full-validation-identity.json) passed on `4e73cd8c`: 6,363 package tests, one existing platform skip, 11 standalone Node tests, required shell checks, install/lint/build/configured type checks/audit/secret scan. Thirteen of fifteen Turbo results were cached. One moderate dependency advisory remains. The 357 Swift tests in eight suites and mapped native/mobile/CLI interactions retain their exact earlier source scope: all three client directories are unchanged from `15900d9e`, as [verified here](receipts/checkpoint-122-source-identity.json).
- [Fresh matched replay](receipts/checkpoint-122-validation-replay.json): 613.435166 ms baseline versus 1,764.543375 ms reuse, zero escaped seeded defects, unchanged coverage and oracle. The 25% speed target remains unsupported on this local fixture. No live speed claim.

## Completed inspections; do not request them again

Checkpoints 107–110 fulfilled the approved bounded Azure metadata, backup restore, API and targeted profile/journal reads. Their approval was specific and is consumed.

The pinned VM is `/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.Compute/virtualMachines/autopod-daemon`, immutable VM ID `3addc9bc-4812-4892-98d6-c40d5ab893c0`, Sweden Central. Revalidate identity before any newly authorized operation.

The September 9 guest inspection matched the active database `/data/autopod/autopod.db` device/inode `2049/13107203` to the service descriptor. It reported schema maximum 152, 150 applied-version rows and migration-file bytes matching main `c0e5a5b4`. [Checkpoint 108](checkpoint-108.md) verified an actual sampled backup through an isolated on-VM restore: schema/watermarks matched, integrity/foreign keys and rollback-only write probe passed, the private copy was removed and active identity stayed stable. Creation provenance was unavailable; this is not a fresh future cutover backup or proof of candidate upgrade compatibility.

The service used release directory `c0e5a5b4`, while its checkout reported `2523ed7b91ecefa1729dfbc177612e76cd90b548` with tracked changes. Incremental deployment can preserve copied Git metadata. Neither the directory label nor this checkout proves loaded bundle identity. Health and bounded API success prove availability only.

The targeted historical journal read found 47 disk-full errors and 369 other errors, none correlated with the failing history/cost requests. Only successful route statuses were classified. An archived trace from the actual failing requests is still needed for the historical causal claim. Do not substitute another generic aggregate read or infer causality from later maintenance.

Checkpoint 123 observes service PID 125941 in `/opt/autopod/releases/ca92847a/packages/daemon`, Node v22.23.1 and the same intended active database inode held by the service. The old backup is absent. New snapshot `/data/autopod/backups/1788982545717.db` is 877,150,208 bytes, stable, schema 153, SHA-256 `126489a4fdc690888999dd487677774e000be00ba878b93e087d9e36c8fb28fc`; available scratch was 139,110,006,784 bytes. These observations supersede the old directory/backup identities. The exact snapshot upgrade subsequently passed at checkpoint 124, but does not attest loaded bundle bytes or fresh active-row equivalence. See [execution receipt](receipts/checkpoint-123-hosted-execution.json).

The checkpoint-124 read-only refresh returned HTTP 200 from public health with no release field. This is current availability, not loaded-source attestation. [Readiness receipt](receipts/checkpoint-124-remaining-readiness.json).

## Required native acceptance verified

Checkpoint 115 passed twelve native cases together on unchanged application source `f93dd4d9`: cost/duration coverage, detail guidance disclosure, failed-reply retention, saved guidance without an acknowledgement claim, unavailable provider disposition, intentional rerun recovery with old-error clearance, unavailable readiness with approval disabled, retained task accounting, exact scan source/human-selected repair, unverified-termination refusal, failed/pass/failed validation history, and one-use validation retry authorization. [Source-bound receipt](receipts/checkpoint-115-native-identity.json). Five built-mobile fault paths passed at checkpoint 113.

The scan disclosure failure was a harness click-coordinate miss; its actual visible arrow is offset from its accessibility frame. The history failures were incorrect menu/control and expected-text selectors. Neither required a product change. The native rerun correction now has actual GREEN interaction proof.

Checkpoint 117 adds five direct native flows: refreshed recorded merged disposition with current provider status still unverified; unresolved restart ownership warning; actionable reviewer reason alongside retained findings; approval preservation/retry; and scan policy saving, retained report navigation and quit/relaunch persistence. [Direct receipt](receipts/checkpoint-117-native-direct.json). The reviewer reason required a product correction; the clean pipeline and 357 Swift tests pass on 15900d9e. The supplemental XCTest runner timed out before any case, but supported direct CUA interactions worked after the usage limit cleared.

Checkpoint 119 verifies native reviewer CLI/contract presentation with explicit missing provider/account/daemon/resource identity. Checkpoint 120, after the user unlocked the Mac, verifies worker reauthorization/rework consumption, empty delta, historical waiver with failed execution retained, and recorded closed disposition. [Direct receipt](receipts/checkpoint-120-native-direct.json). All workstream-5 criteria are now verified within the required local/supported-surface scope, using earlier actual scheduler/collector/durable report tests plus native policy/report/triage checks.

Checkpoint 121 verifies the remaining listed native cases: retained deleted fleet navigation, guidance receipt history and populated execution release/image/resource fields. [App/fixture-bound receipt](receipts/checkpoint-121-native-direct.json). Native interaction prerequisites are closed within recorded scope; synthetic receipts never attest hosted source or provider execution. The Mac relocked during cleanup after all checks passed and is no longer blocking these criteria. The approved checkpoint-122 hosted-copy attempt refused before copy at checkpoint 123. The current service cwd is ca92847a and the old snapshot has been removed. The replacement checkpoint-123 packet was explicitly approved and passed at checkpoint 124; no copy-upgrade approval remains pending.

## Remaining sandbox access and paid-canary gate

The actual affected `dataverse-harness` image is `ewiautopodacr.azurecr.io/autopod/dataverse-harness:latest`, resolved during checkpoint 110 to `sha256:4b836cdabc71ffd40aef564b65b6b16564c5312770130bc59251a732078c9d77`. Do not substitute the unrelated autopod-self image.

PIM restored reads on `autopod-spike-neu` in North Europe (CP126 HTTP 200). The only same-repository ready disk carries an older digest. Existing managed identity AcrPull is verified; no role changes are needed. The [exact image import/canary packet](exact-image-canary-packet.md) now pins request bodies, commands/oracles, cleanup and known-component cost with ancillary-cost uncertainty. It supersedes the historical access request. Paid execution remains unapproved.

Once read access is supplied, resolve an existing matching ready disk-image identity. If import is necessary, price and request that explicitly. The proposed canary remains one disposable sandbox, one creation attempt, no model calls, explicit 2 vCPU / 4 GiB / 40 GiB, at most five minutes through cleanup, subject to verifying the affected profile's requirements. A lost creation response requires reconciliation rather than a second creation. Verify removal of the exact created resource.

The historical estimate is $0.018 compute for five minutes; it is **not a total quote or a billing cap**. Refresh applicable pricing and resolve image/storage/transfer/cleanup costs before asking for spend approval. Final commands must pin runtime CLI path/version, effective exec/upload user, resource limits, stream chunks/exit and a nonsecret sentinel through the actual upload plus atomic `runtimeConfigInstallCommand`. Do not alter ownership privileges to force success. The relevant .NET check must use supported NuGet list/help/package-search semantics and separately identified feed/auth scope. Local command-construction tests do not satisfy actual-image acceptance.

## Actual database compatibility and rollout preparation

Candidate migrations through 183 are locally covered, including representative managed/native lineage upgrades and immutable claim/history rules. The on-disk manifest and older sampled restore alone did not prove candidate compatibility; the exact hosted snapshot upgrade at checkpoint 124 now supplies that proof within its recorded scope. The [isolated upgrade packet](isolated-upgrade-verification-packet.md) has the unchanged candidate migration runner and eleven passing local copy/fault/CLI tests. Checkpoint 123 records the earlier refused attempt and passes eleven copy/CLI plus ten wrapper tests. The explicitly approved replacement packet passed on the VM at checkpoint 124: actual snapshot 153→183, preserved original columns/rows, integrity/FK/backfill/write probe, unchanged input and complete private cleanup. This closes compatibility for that exact snapshot/candidate pair; a future cutover needs fresh evidence. Keep database contents on the VM; export only bounded verdict/provenance data. Any candidate upload, copy/upgrade execution and output handling require a concrete separately approved packet. Never migrate or replace the active database as an acceptance experiment.

Before a publication/deployment request:

1. Native acceptance and exact local app/source identities are recorded through checkpoint 121. Checkpoint 122 integrates current main and verifies migration compatibility through 183. Recheck remote state before publication and rerun required checks if source changes.
2. Resolve actual loaded/rollback source. Exact historical snapshot/candidate compatibility passed at checkpoint 124; revalidate if the candidate or intended lineage changes. Prepare exact deployment build/upload/verification commands and data handling before any deployment approval.
3. Establish no restart-blocking pods through existing drain/API/DB safeguards. Reconcile worker and cleanup ownership with trustworthy original resource identity and observed terminal exit. Time, restart, guessed PIDs or unknown cloud status do not release claims.
4. Produce a fresh WAL-aware cutover backup and verify intended scope/freshness, isolated restoration and headroom (two copies plus reserve). Keep sampled historical restore acceptance distinct from this fresh cutover gate.
5. After explicit publication authority, publish only the approved source. After explicit deployment/restart authority, use the hosted deployment skill and verified target layout, a full build when provenance is ambiguous, mandatory browser prewarm, bounded health and post-start source/migration evidence. Do not use `--force` without authority naming affected work.

No executable deployment command is presented as ready while these requirements remain open. The previous command naming `90a61141` is superseded; the current candidate is not deployed or published.

## Rollback and stop rules

Stop on unknown lineage, missing compatible rollback identity, failed fresh backup/restore/headroom, active or unresolved ownership, failed build/prewarm, source mismatch or failed acceptance. Before cutover, retain the current service/source/database unchanged.

After cutover, symlink-only downgrade is unsafe by default: durable history/guidance/worker/cleanup rules must survive. Preserve post-cutover database/WAL and source; drain under the approved procedure and establish observed settlement. Prefer a forward correction when older writers cannot preserve new records. A separately approved rollback must use a proven compatible release/database pair and reconcile post-cutover work, decisions and deliveries before replacement. Never discard them to satisfy a rollback check.
