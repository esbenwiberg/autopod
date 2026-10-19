# Workspace transfer extraction implementation plan

Status: COMPLETE — all three approved phases implemented and locally verified.
Baseline: 944f5c46cece345dbf3786bd8ca4c57ebf6fe326.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Continue the accepted incremental rewrite by extracting the local workspace
transfer operation behind the callback established in the first extraction.
Keep the accepted three-phase structure: characterize, extract, qualify.

The user explicitly approved this concrete plan in the conversation. All three
phases are authorized together; no intermediate manual gate is required.

## Current state analysis

See ../research/2026-10-17-pod-manager-workspace-transfer.md for the verified map.
References here use packages/daemon/src/ at baseline 944f5c46.

pods/pod-manager.ts:5639 exposes syncWorkspaceBack within the manager closure.
Its implementations at :6124, :6289 and :6364 own copying, archive fallback and
live recovery. Retry helpers at :5522–5618 surround transfer. waitForContainerReachable
also serves validation at :14873. Mirror helpers at :619–697 and bare-directory
derivation at :1104 have provisioning, approval and validation consumers.

## Desired end state

- A typed transfer factory owns existing synchronization and live file recovery.
- Public manager signatures, callbacks, results, status changes and cleanup stay
  identical. Validation keeps its existing 30-second reachability call.
- Shared mirror primitives preserve provisioning's inclusion of .git and sync's
  exclusion of .git. Approval retains its exact exclusion list.
- Real private Git/filesystem tests execute the final transfer boundary, while
  unchanged public characterization checks manager composition before and after.
- The extracted module has no manager, repository, lifecycle or cleanup dependency.

## What we are not doing

No retry redesign, cancellation, locking, atomic-copy guarantee, archive cleanup
redesign, temp naming fix, sandbox routing migration, Git publication algorithm
change, validation reconciliation, status/commit policy, schema, profile, API,
provider, dependency, deployment, real pod run, PR creation or main merge.
Any reproduced behavior defect outside mechanical compatibility is documented
separately; it is not silently repaired during extraction.

## Implementation approach

Change precisely these five product files:

1. New pods/workspace-transfer.ts: createWorkspaceTransfer({ logger }) returns
   syncWorkspaceBack and recoverWorktreeFromContainer with their existing typed
   signatures. Export waitForContainerReachable for the existing validation call.
   Keep looksLikeEngineStall, withEngineStallRetry, syncWorkspaceBackOnce,
   extractWorkspaceBackAndRecoverGit and refreshHostWorktreeIndex private.
   Logger is Pick<Logger, 'info' | 'warn'>. ContainerManager and ExecutionTarget
   remain domain types. Infrastructure remains explicit operation arguments.
2. New pods/workspace-mirror.ts: move WORKSPACE_RUNTIME_CACHE_EXCLUDES,
   WORKSPACE_SYNC_EXCLUDES, workspaceMirrorPruneExpression,
   workspaceMirrorPreservePredicates and buildWorkspaceMirrorCopyScript unchanged.
   These serve transfer and existing manager provisioning/approval code.
3. New util/shell-quote.ts: move the existing shellQuote implementation unchanged;
   manager and mirror import it. Preserve all unrelated quoting callers.
4. worktrees/bare-push.ts: export the existing deriveBareRepoPath helper unchanged
   alongside the existing staging publication primitive. Add node:path import.
   Both manager and transfer import it. Leave staging publication unchanged.
5. pods/pod-manager.ts: import shared helpers and compose the transfer factory once
   before preservation composition. Remove only the moved definitions. All current
   callers remain in place. Remove imports only when their remaining uses permit.

This avoids a runtime dependency back into the manager and keeps shared generic
helpers outside the factory. Do not introduce a service registry or public test seam.

Compatibility details to preserve exactly:

- Default local target, positional arguments and returned boolean/result shapes.
- Matching alternates prerequisite for container push; mismatch still copies files.
- safe.directory persistence, commands, timeouts, exclusions, quoting, script order,
  sanitized staging prefix, copy count check and existing shell trap.
- File copy and commit publication are distinct outcomes. pushed=false remains
  usable by manager deletion guards; it must not become a generic failure.
- Any exec/copy/index exception takes the existing archive route. Archive files
  precede separate .git recovery. Git recovery remains best effort; successful
  publication requires the existing host index refresh.
- Retry classification is applied to final operation rejection after fallback;
  preserve three attempts, 5/15-second wait budgets and 2-second probes. Timeout
  still permits a retry; stopped/deleted stops it and preserves the prior error.
- Live recovery requires running, tolerates a returned failed push, and returns
  false on thrown extraction/index/status errors. Manager interprets that result.
- Generic sandbox transfer continues to use archive fallback; verified sandbox
  preservation continues to use the checkpoint path from the preceding extraction.

## Phase 1: characterize current transfer through public manager operations

### Changes required

Only pods/pod-manager.test.ts. Add a named 'workspace transfer compatibility' group
using existing createTestContext and shared mock infrastructure. Reuse existing
assertions where they already establish the same contract. No production seam.

Cover these behavior groups before moving code:

1. Local mirror success and mismatched/underivable alternates: file sync still runs,
   forbidden push does not run, returned evidence keeps deletion-guard behavior.
2. Exec/copy failure selects workspace archive then separate Git recovery; workspace
   extraction failure propagates to existing manager failure handling. A skipped or
   failed Git recovery retains file success with pushed=false.
3. Successful Git publication refreshes the host linked-worktree index. A failed
   refresh takes the existing fallback path. Preserve existing deletion-guard checks.
4. Engine failures from the complete transfer chain retry at most three times;
   domain errors and non-Error rejections do not. Running permits immediate retry,
   stopped/deleted abort, unknown and status errors exhaust their polling budget
   and permit the next attempt. Use fake time with bounded advancement and restore
   real timers in finally; preserve the final error where the public path exposes it.
5. Live recovery requires running. Failed push can still lead to recovered files;
   extraction/index exceptions return failure and retain public fallback behavior.
6. Preserve existing legacy sandbox archive and verified checkpoint routing tests.

Every new fixture closes its SQLite database. Release and await held operations,
restore spies/timers, and use private temporary directories. Record baseline source
and test hashes and a source manifest proving no production edits in this phase.

### Success criteria

Automated:
- [x] New public characterization passes at the recorded unchanged product baseline.
- [x] Existing relevant sync/recovery and preservation tests pass.
- [x] Fixtures terminate and release databases, timers and temporary resources.
- [x] Before-source and test hashes/logs are retained under ignored task evidence.

Manual: None required for this headless compatibility boundary.

## Phase 2: move the boundary and prove actual file/Git outcomes

### Changes required

Apply the five-file movement described above. Add pods/workspace-transfer.test.ts
and focused bare-push.test.ts cases for the relocated common-directory helper.
Keep Phase 1 assertions byte-identical. Do not consolidate merely similar algorithms.

Use actual private local bare repositories, linked host worktrees and container-like
Git directories patterned after bare-push.test.ts. A controlled ContainerManager
adapter executes the production command with only its private container and bind
paths mapped locally; no Docker server, external repository or provider is needed.
Never persist safe.directory in the person's Git configuration: the fixture supplies
private Git configuration and restores its environment after each test.

Meaningful boundary cases:

- Execute the production mirror on committed and dirty files, deletion of old paths,
  names with spaces/apostrophes, symlinks and executable mode. Assert host .git and
  host cache sentinels survive and source contents/HEAD/index remain unchanged.
- Force a staging-copy failure before overlay, with archive fallback also failing;
  assert existing host file sentinels remain. Do not claim rollback after a partial
  overlay or crash atomicity.
- Exercise real staging-ref promotion, host HEAD/index alignment and dirty file
  preservation. Verify staging refs and temporary staging paths at actual exit.
- Mismatched alternates cannot redirect publication; private unrelated bare refs
  remain unchanged even while ordinary file synchronization succeeds.
- Execute archive fallback through a local extraction adapter, including separate
  .git recovery, returned false evidence and temporary-directory cleanup. A local
  adapter proves orchestration, not Docker tar implementation.
- Execute shared mirror helper with provisioning's cache-only exclusions and sync's
  .git-plus-cache exclusions, asserting the different .git outcomes.
- deriveBareRepoPath resolves the actual common directory for linked worktrees
  and ordinary repositories, including relative Git output.

Record an exact movement comparison for moved implementations/constants, allowing
only planned imports, exports, factory indentation and logger dependency wiring.
Verify unrelated manager regions and the staging publication algorithm are unchanged.

### Success criteria

Automated:
- [x] Identical Phase 1 public cases pass after extraction.
- [x] Real local file/Git cases establish the outcomes above.
- [x] Exact movement receipt and dependency review show only planned adaptation.
- [x] Shared provisioning, approval, validation and preservation callers remain wired.
- [x] Product diff contains only the five planned files; tests/docs are separately listed.

Manual: None required. No live Docker or cloud acceptance is claimed.

## Phase 3: qualify and record the final change

Reuse the task-local ignored npx launcher from the first extraction, pinning actual
child processes to Node 22.23.3 and pnpm 9.15.4. Verify actual child runtime and a
SQLite memory database before execution. Do not change product scripts/dependencies.
Record evidence in .autopod-data/workspace-transfer/; keep earlier receipts intact.

Commands from the isolated worktree with its existing runtime shim on PATH:

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'workspace transfer compatibility'

Run the new transfer suite and the complete previously qualified affected set:

    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/workspace-transfer.test.ts src/pods/workspace-preservation.test.ts src/pods/pod-manager.test.ts src/pods/workspace-checkpoint-controller.test.ts src/worktrees/sandbox-workspace-checkpoint.test.ts src/worktrees/bare-push.test.ts src/pods/workspace-branch-publication.test.ts src/pods/artifact-preservation.test.ts src/pods/artifact-preservation.sandbox.test.ts src/pods/artifact-snapshot-receipt.test.ts src/pods/artifact-snapshot-inventory.test.ts src/pods/artifact-resume-observation.test.ts src/pods/completion-journal.test.ts src/pods/local-reconciler.test.ts src/pods/pod-lifecycle.e2e.test.ts

    npx pnpm exec biome check packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/workspace-transfer.ts packages/daemon/src/pods/workspace-transfer.test.ts packages/daemon/src/pods/workspace-mirror.ts packages/daemon/src/util/shell-quote.ts packages/daemon/src/worktrees/bare-push.ts packages/daemon/src/worktrees/bare-push.test.ts
    git diff --check
    TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Use the full pipeline's frozen install and complete lint/build/typecheck/test/audit/
secret checks. Hash final sources before and after validation. Record exact commands,
exit codes, passed/skipped counts, filtered cases and unavailable gates. Review the
final diff. Commit and push validated increments under repository instructions.

### Success criteria

Automated:
- [x] Affected suites and full uncached pipeline pass on frozen final product sources.
- [x] Source identities, actual runtime, before/after results and limits are recorded.
- [x] Final diff review confirms compatibility scope and no unrelated policy changes.
- [x] Validated commits are pushed and remote commit identity is checked.

Manual: None required. PR/integration and deployment remain separate requests.

## Testing strategy and evidence limits

Public characterization protects composition. Direct tests execute actual mirror
scripts, Git and filesystem outcomes. Existing suites protect preserved lifecycle,
checkpoint, artifact and publication behavior. New checks must assert durable resource
outcomes rather than merely repeat implementation calls. No live Docker/Azure,
process-death, cross-process serialization or new atomicity claim follows from this
movement. A failing/unavailable gate remains explicit and incomplete.

## Performance considerations

No new I/O or additional retry is planned. One factory replaces existing closure
functions. Preserve lazy timing and Date.now evaluation. No speed claim.

## Migration and rollback

No schema, API, stored-record or profile change. Revert the module/shared-helper and
manager wiring changes together; no database rollback is needed. Retain tests and
record any later intentional behavior change in a separately approved scope.

## References and next action

- Research: ../research/2026-10-17-pod-manager-workspace-transfer.md.
- Completed predecessor: 2026-10-17-pod-manager-workspace-preservation.md.
- Existing real Git pattern: packages/daemon/src/worktrees/bare-push.test.ts.

All three approved phases are complete. No manual verification is required for
this headless compatibility boundary. PR/integration and deployment remain
separate actions; neither was performed.

## Phase 1 evidence

Thirty-five new public transfer compatibility cases passed against unchanged
product source at baseline 944f5c46, together with the 17 preservation cases and
six existing sync/recovery cases: 58 passed, 668 name-filtered. The actual test
child runtime is Node 22.23.3 via the existing ignored launcher; SQLite is included.

The first run found three over-broad fixture assertions: successful activity
updates lastAgentEventAt. Those assertions were narrowed to the planned lifecycle
and source-resource invariants. No production source or behavior changed. Its
failed log remains characterization-initial-failure.log. The passing baseline and
source/test identities are under .autopod-data/workspace-transfer/.

## Phase 2 evidence

The five approved product files now contain the extraction. pod-manager is reduced
by 507 lines. All moved implementations/constants and the remaining manager match
the mechanical construction exactly, allowing only Biome's relocation of two
imports. The staging publication algorithm and 1,462 unrelated baseline product
paths are unchanged. Phase 1 characterization is byte-identical.

The same 58 selected public cases pass after extraction (668 name-filtered).
Nine direct boundary cases execute actual local shell/Git/files, and two new
bare-push cases cover common-directory derivation. All 15 affected suites pass:
870 tests, zero skipped. The daemon/dependency build, eight-file scoped Biome
and whitespace checks pass. Actual SQLite opens under the verified Node 22 child.

The first material-boundary run had three fixture failures: macOS resolves linked
worktree common directories through /private/var, while fixtures supplied /var.
The fixture root and linked-worktree expectation now use canonical paths, retaining
the strict production comparison. No product behavior or assertion of publication
authority was weakened. material-boundary-initial-failure.log remains available.

Private Git configuration isolates safe.directory writes. File cases assert dirty
and committed bytes, old-path removal, symlinks, executable mode, retained host
gitlink/caches, untouched source HEAD/index, blocked unrelated-ref publication,
archive recovery and temporary Git removal. Fixture cleanup also removes captured
temporary directories if an assertion fails. Archive orchestration uses a local
copy adapter; it is not live Docker tar qualification.

Receipts under .autopod-data/workspace-transfer/: movement.json, runtime.json,
characterization-before.log, characterization-after.log, affected.log, build.log,
scoped-biome.log and the frozen baseline/test copies. Full pipeline acceptance
remains incomplete until its actual result is recorded.

## Final verification: Phase 3

Verdict: PROVEN for the approved local compatibility extraction. All required
implementation and automated checks in this plan are complete.

| Claim/check | Observed evidence | Result |
|---|---|---|
| Public behavior retained | Identical assertions: 58 passed before and after; 668 other manager tests name-filtered in each selected run | Passed |
| Transfer material boundary | Nine direct tests execute real local shell/Git/files; two new common-directory cases plus existing staging-publication coverage | Passed |
| Surrounding orchestration retained | All 15 affected suites: 870 passed, zero skipped | Passed |
| Full uncached validation | Frozen install, lint, build, typecheck, tests, audit and secret scan | Passed |
| Repository Vitest | 7,240 passed across 489 passing files; 10 existing skips, including five fully gated files | Passed with existing skips |
| Standalone Node scripts | 35 passed, zero skipped | Passed |
| Shell scripts | Hosted release verification, build provenance and hosted cleanup checks | Passed |
| Source identity | All 1,949 frozen package/script files unchanged through validation | Passed |
| Scoped lint/whitespace | Eight changed TypeScript files clean; git diff --check clean | Passed |
| Dependency audit | No known vulnerabilities found | Passed |

Command: TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh under verified
Node 22.23.3 and pnpm 9.15.4. Turbo build/typecheck/test groups reported 7, 11
and 15 successful tasks respectively, all with zero cached tasks. Repository
Biome passed with 82 existing warnings; changed-file Biome had no warnings.

The 10 skipped cases are the existing platform-specific Docker container case,
the optional live-model RPI case, and Docker gates in isolated-deploy-runner,
native-goal-recovery, sidecar-isolation, local-runtime and reference-snapshots.
No new test was skipped. SQLite was forced on and actually opened under Node 22.

The validated implementation commit is ccfb5d81. The subsequent documentation
commit only records these results. Production helper bodies, callbacks and
shared callers match the recorded movement receipt. The manager retains lifecycle,
commit/deletion guards, validation reconciliation, compromised-worktree decisions
and cleanup. No schema, API, profile, dependency or publication algorithm changed.

Private proof: .autopod-data/workspace-transfer/proof.json, movement.json,
final-source-manifest.json and full-validation.log, with actual log/source hashes.
Both earlier failed fixture runs remain retained and are not relabeled as passing.
The source identities match the final implementation. Final documentation commit
and remote identity are appended to the private proof after push confirmation.

Limits: controlled local container adapters establish local orchestration and
material Git/filesystem outcomes. No live Docker/Azure, real provider, external
Git remote, deployment, PR, main merge, process-death proof or new atomic-copy/
cross-process serialization guarantee is claimed. No manual acceptance remains.
