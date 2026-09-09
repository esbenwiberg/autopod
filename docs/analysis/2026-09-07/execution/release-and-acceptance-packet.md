# Release and remaining acceptance packet

Updated September 9, checkpoint 119. This packet supersedes the dated approval requests in checkpoints 106–110. Their raw receipts remain retained. It is a local review artifact; it does not authorize publication, deployment, restart, cloud access changes or a paid canary. The goal remains incomplete.

## Current tested candidate

- Application source: `15900d9e08a7e4ca786a6ad11ff81820fda14de4`, isolated branch `codex/durable-execution-contract` at `/private/tmp/autopod-durable-execution`.
- [Current non-documentation patch](receipts/checkpoint-117-candidate-code.diff) and [base/candidate blob manifest](receipts/checkpoint-117-candidate-manifest.json). Comparison base `c0e5a5b4617d131257e2c448f2259b645ac351ee` is the historical integrated main from checkpoint 106, **not a fresh remote-main assertion**. Refresh main and migration numbering before any publication proposal. The patch uses `--binary --unified=0`; applying it requires the exact base and `git apply --unidiff-zero`.
- Governing contract SHA-256: `3dc5e753db8ec664ea8ed1a93b1150c936ea53cbc8e9f8a0def05113dfd1e481`; unchanged from the original checkout. Unrelated original checkout changes remain excluded.
- [Clean full pipeline](receipts/checkpoint-117-full-validation-identity.json) passed on `15900d9e`; install, lint, configured build/type checks, tests, audit and secret scan passed. Fourteen of fifteen Turbo results were cached. Native Swift freshly passed 357 tests in eight suites. One moderate dependency advisory remains.
- [Matched replay](receipts/checkpoint-112-validation-replay.json): 667.521167 ms baseline versus 1,921.298583 ms reuse, zero escaped seeded defects, unchanged coverage. The 25% speed target is unsupported on this local fixture. The subsequent one-line native error-clear change does not touch benchmark source/inputs. No live speed claim.

## Completed inspections; do not request them again

Checkpoints 107–110 fulfilled the approved bounded Azure metadata, backup restore, API and targeted profile/journal reads. Their approval was specific and is consumed.

The pinned VM is `/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.Compute/virtualMachines/autopod-daemon`, immutable VM ID `3addc9bc-4812-4892-98d6-c40d5ab893c0`, Sweden Central. Revalidate identity before any newly authorized operation.

The September 9 guest inspection matched the active database `/data/autopod/autopod.db` device/inode `2049/13107203` to the service descriptor. It reported schema maximum 152, 150 applied-version rows and migration-file bytes matching main `c0e5a5b4`. [Checkpoint 108](checkpoint-108.md) verified an actual sampled backup through an isolated on-VM restore: schema/watermarks matched, integrity/foreign keys and rollback-only write probe passed, the private copy was removed and active identity stayed stable. Creation provenance was unavailable; this is not a fresh future cutover backup or proof of candidate upgrade compatibility.

The service used release directory `c0e5a5b4`, while its checkout reported `2523ed7b91ecefa1729dfbc177612e76cd90b548` with tracked changes. Incremental deployment can preserve copied Git metadata. Neither the directory label nor this checkout proves loaded bundle identity. Health and bounded API success prove availability only.

The targeted historical journal read found 47 disk-full errors and 369 other errors, none correlated with the failing history/cost requests. Only successful route statuses were classified. An archived trace from the actual failing requests is still needed for the historical causal claim. Do not substitute another generic aggregate read or infer causality from later maintenance.

## Native acceptance in progress

Checkpoint 115 passed twelve native cases together on unchanged application source `f93dd4d9`: cost/duration coverage, detail guidance disclosure, failed-reply retention, saved guidance without an acknowledgement claim, unavailable provider disposition, intentional rerun recovery with old-error clearance, unavailable readiness with approval disabled, retained task accounting, exact scan source/human-selected repair, unverified-termination refusal, failed/pass/failed validation history, and one-use validation retry authorization. [Source-bound receipt](receipts/checkpoint-115-native-identity.json). Five built-mobile fault paths passed at checkpoint 113.

The scan disclosure failure was a harness click-coordinate miss; its actual visible arrow is offset from its accessibility frame. The history failures were incorrect menu/control and expected-text selectors. Neither required a product change. The native rerun correction now has actual GREEN interaction proof.

Checkpoint 117 adds five direct native flows: refreshed recorded merged disposition with current provider status still unverified; unresolved restart ownership warning; actionable reviewer reason alongside retained findings; approval preservation/retry; and scan policy saving, retained report navigation and quit/relaunch persistence. [Direct receipt](receipts/checkpoint-117-native-direct.json). The reviewer reason required a product correction; the clean pipeline and 357 Swift tests pass on 15900d9e. The supplemental XCTest runner timed out before any case, but supported direct CUA interactions worked after the usage limit cleared.

Checkpoint 119 additionally verifies the native host reviewer CLI/contract display and explicit unverified provider/account/daemon/resource fields. This is synthetic presentation proof only. The Mac locked again before the next case; the pending manual-unlock request is current. New worker/waiver/empty-scan fixture checks pass, but their UI cases remain unrun.

Remaining native acceptance includes worker binding reconciliation, guidance acknowledgement presentation, historical waiver, recorded closed disposition, empty-delta report, retained fleet navigation and populated execution provenance. Screenshots were observed only from the task-owned app/window. Narrow wrapping is not a layout audit pass.

## Remaining sandbox access and paid-canary gate

The actual affected `dataverse-harness` image is `ewiautopodacr.azurecr.io/autopod/dataverse-harness:latest`, resolved during checkpoint 110 to `sha256:4b836cdabc71ffd40aef564b65b6b16564c5312770130bc59251a732078c9d77`. Do not substitute the unrelated autopod-self image.

The configured group is `autopod-spike-neu`, North Europe, under resource group `ewi-sandboxes`. Its disk-image data-plane GET returned 403. No role assignment or paid canary has been authorized. An administrator must supply suitable access at the intended group scope. See [targeted prerequisites](targeted-acceptance-prerequisites.md) and the retained role/read receipts. Do not switch credentials or create/garbage-collect disk images to bypass the refusal.

Once read access is supplied, resolve an existing matching ready disk-image identity. If import is necessary, price and request that explicitly. The proposed canary remains one disposable sandbox, one creation attempt, no model calls, explicit 2 vCPU / 4 GiB / 40 GiB, at most five minutes through cleanup, subject to verifying the affected profile's requirements. A lost creation response requires reconciliation rather than a second creation. Verify removal of the exact created resource.

The historical estimate is $0.018 compute for five minutes; it is **not a total quote or a billing cap**. Refresh applicable pricing and resolve image/storage/transfer/cleanup costs before asking for spend approval. Final commands must pin runtime CLI path/version, effective exec/upload user, resource limits, stream chunks/exit and a nonsecret sentinel through the actual upload plus atomic `runtimeConfigInstallCommand`. Do not alter ownership privileges to force success. The relevant .NET check must use supported NuGet list/help/package-search semantics and separately identified feed/auth scope. Local command-construction tests do not satisfy actual-image acceptance.

## Actual database compatibility and rollout preparation

Candidate migrations through 182 are locally covered, including representative managed/native lineage upgrades and immutable claim/history rules. The on-disk hosted migration manifest and sampled restore do not prove an upgrade of the actual intended database to this candidate. The [isolated upgrade packet](isolated-upgrade-verification-packet.md) now has a packaged actual candidate runner and eight passing local copy/fault/CLI tests. Checkpoint 118 seals the bounded transport/watchdog/cleanup wrapper and exact source/backup identities, with eight additional passing local wrapper tests. Its exact source upload and isolated-copy execution remain pending explicit approval. Keep database contents on the VM; export only bounded verdict/provenance data. Any candidate upload, copy/upgrade execution and output handling require a concrete separately approved packet. Never migrate or replace the active database as an acceptance experiment.

Before a publication/deployment request:

1. Finish native acceptance and freeze exact source/build artifact identities. Refresh main and migration prefixes, integrate only supported changes, and rerun required checks if source changes.
2. Resolve actual loaded/rollback source and prove candidate compatibility against the verified database copy. Prepare exact build/upload/verification commands and data handling before approval.
3. Establish no restart-blocking pods through existing drain/API/DB safeguards. Reconcile worker and cleanup ownership with trustworthy original resource identity and observed terminal exit. Time, restart, guessed PIDs or unknown cloud status do not release claims.
4. Produce a fresh WAL-aware cutover backup and verify intended scope/freshness, isolated restoration and headroom (two copies plus reserve). Keep sampled historical restore acceptance distinct from this fresh cutover gate.
5. After explicit publication authority, publish only the approved source. After explicit deployment/restart authority, use the hosted deployment skill and verified target layout, a full build when provenance is ambiguous, mandatory browser prewarm, bounded health and post-start source/migration evidence. Do not use `--force` without authority naming affected work.

No executable deployment command is presented as ready while these requirements remain open. The previous command naming `90a61141` is superseded; the current candidate is not deployed or published.

## Rollback and stop rules

Stop on unknown lineage, missing compatible rollback identity, failed fresh backup/restore/headroom, active or unresolved ownership, failed build/prewarm, source mismatch or failed acceptance. Before cutover, retain the current service/source/database unchanged.

After cutover, symlink-only downgrade is unsafe by default: durable history/guidance/worker/cleanup rules must survive. Preserve post-cutover database/WAL and source; drain under the approved procedure and establish observed settlement. Prefer a forward correction when older writers cannot preserve new records. A separately approved rollback must use a proven compatible release/database pair and reconcile post-cutover work, decisions and deliveries before replacement. Never discard them to satisfy a rollback check.
