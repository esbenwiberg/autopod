# Slice 10: post-validation evidence collection extraction

Status: APPROVED — implementation in progress.
Date: 2026-10-18.
Baseline: fa4f8abab07ee54147ec1b01d529ff3b745ce43a.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Extract ordinary validation's post-check evidence collection and workspace sync
into validation-evidence.ts. Preserve the order that protects host screenshots and
the sync flag that tightens the later deletion guard. Use the established
characterize → extract → qualify structure. Approval covers all three phases
together; no intermediate manual acceptance is required for this headless boundary.
Commit and push verified increments per the user's repository instructions.

## Current state analysis

Research: ../research/2026-10-18-pod-manager-validation-evidence.md.
The manager is 17,511 lines at baseline. pod-manager.ts:13602–13723 contains a
122-line contiguous region, including its trailing blank. It computes three gates,
saves host fact screenshots before sync, performs target-specific workspace sync,
attaches smoke screenshot refs, then collects fact screenshots again. Result
persistence starts at :13724. The sync flag later selects mergeBranch maxDeletions
100 or 0 (:14187). Manual revalidation keeps a different path.

## Desired end state and scope

Exactly two product paths change:
- New packages/daemon/src/pods/validation-evidence.ts.
- packages/daemon/src/pods/pod-manager.ts: import/composition, the one block replaced
  with a returned-flag assignment, and removal of now-unused collector imports.

Exactly two test paths change:
- packages/daemon/src/pods/pod-manager.test.ts: public baseline characterization.
- New packages/daemon/src/pods/validation-evidence.test.ts: direct contract/filesystem proof.

The manager retains finalizing activity, ownership/controller cleanup, lifecycle
checks, pre-validation sync, result/history/token persistence, decisions, councils,
correction, screenshot publication, deletion guard, shutdown and delivery. Keep
formatElapsedDuration in manager and inject its existing function. Shared collectors,
store, workspace/checkpoint helpers and manual revalidation remain unchanged.
No new schema/state/API/profile field/dependency, retry or evidence policy, ownership
fence, live deployment, PR or main integration. No unrelated harness-race fixes.

## Implementation approach

Create createValidationEvidence with eight existing collaborators:
1. logger: Pick<Logger, 'info' | 'warn'>.
2. containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager }.
3. checkpointSandboxWorkspaceForPod(pod: Pod): Promise<WorkspaceCheckpointResult>.
4. syncWorkspaceBack(containerId: string, worktreePath: string, cm: ContainerManager,
   podId: string, executionTarget: Pod['executionTarget']): Promise<{ pushed: boolean }>.
5. screenshotStore?: ScreenshotStore.
6. hostScreenshotDir?: (podId: string) => string.
7. emitActivityStatus(podId: string, message: string): void.
8. formatElapsedDuration(durationMs: number): string.

Use existing type modules only; no import from pod-manager.ts. Import node:path,
collectScreenshots and collectFactScreenshots directly from their existing modules.
Do not add production-only collector, clock or filesystem hooks. Capture the same
store/resolver references at construction as the manager currently does. Construction
performs no I/O or collaborator calls. Factory returns:

    collectValidationEvidence(
      podId: string, pod: Pod, result: ValidationResult, validationSyncOk: boolean,
    ): Promise<boolean>

Move the exact block as the operation body, with the incoming flag as a mutable
parameter and a final return validationSyncOk. Keep podId distinct from pod.id:
existing activity/log/sync calls use podId while collector/resolver calls use pod.id.
No body receiver substitutions or behavioral rewrites are needed.

Compose immediately after createValidationExecution. At the original location:

    validationSyncOk = await collectValidationEvidence(podId, pod, result, validationSyncOk);

This introduces one asynchronous function boundary before persistence. Internal
operations keep their existing awaits/order; do not claim identical microtask count
or stronger concurrency guarantees. Keep this delegation inside the original outer
try and after its existing lifecycle check/finalizing activity. Preserve original
result identity and nested mutation. Do not clone, normalize or persist inside module.

Allow typed imports/wrapper/composition, exact block move, one delegation/flag return,
removal of unused collector imports and formatting only. Compare parsed TypeScript
tokens for the moved body and entire remaining manager against this explicit recipe.
Retain all other helpers and call sites byte/token-equivalent as appropriate.

## Compatibility requirements

1. Compute all three gates before I/O. Preserve truthy screenshotPath, relative PNG
   matching and case behavior. The host browser-test gate triggers the collector
   over ALL facts, not a filtered subset; later mutations do not recompute gates.
2. Preserve host-facts → sync → smoke → facts order and exact messages/count fields.
   Host collection precedes destructive mirror sync. Missing store/worktree skips
   collection; missing store alone never disables sync. Missing container skips sync.
3. Sandbox success is exactly promoted && materialized && lineageVerified. Preserve
   the success activity even for an unverified, non-throwing receipt. Other targets
   preserve the incoming flag on success; caught sync errors set false. Evidence
   errors do not independently change it. Keep the later 100-versus-0 deletion guard.
4. Retain result/page/attachment/ref identities, first matching page semantics for
   duplicate paths, missing count, optional host resolver timing and captured refs.
   Pre-sync and final fact passes may write the same store filename twice.
5. Keep catch boundaries and error precedence, including activity outside try,
   successful activity/formatting inside sync try, warn/info failures, resolver
   errors and partial result/store writes. Per-file collector errors are swallowed
   by existing collectors; do not claim they always reach the module catch.
6. Evidence collection does not change overall pass/fail or invent persistence,
   ownership/recovery policy. Existing manager outer catch handles escaping errors.
   Hold real existing seams to observe current behavior during slow work; do not
   add stale-result fences or describe the whole sequence as atomic.

## Phase 1: characterize the public evidence boundary

Only edit pod-manager.test.ts. Add a `validation evidence compatibility` group
using public triggerValidation, migrated real SQLite context, temporary host
worktrees and a real filesystem screenshot store. No future-module import.
Select the existing finalization/checkpoint cases too. Where needed hold existing
container extraction/checkpoint or store.write seams; release/join in finally.

Cover actual stored bytes and refs, not activity messages alone:
- Host fact screenshot exists before post-check sync; a controlled sync overwrites
  or removes that host file. Prove its prior bytes survive in the store. Distinguish
  browser-test gate from collector scope across mixed facts.
- Smoke and fact evidence appears during sync, then is stored and reflected in
  persisted lastValidationResult/history before result publication. Verify actual
  result observations and relative /workspace/allowed-host paths as applicable.
- Absent store/evidence, missing files, rejected paths and failed store writes keep
  current best-effort behavior. Pin exact ordering and unchanged validation outcome.
- Actual caught post-check sync failure versus verified/unverified sandbox receipts.
  Observe degraded activity and mergeBranch maxDeletions=0, versus 100 on ordinary
  verified success. Keep pre-validation sync successful so tests reach this boundary.
- Throwing resolver/collector collaborator versus escaping activity/logger error
  as reachable through existing seams; preserve partial writes and outer handling.
  Capture current behavior around held collection and terminal status without
  strengthening lifecycle guarantees.

Use valid typed fixtures and real temporary filesystem paths; clean up stores,
worktrees, spies, clocks and private databases. Record initial failures/corrections
honestly. Freeze passing public assertions, baseline package/script hashes, runtime,
selected case names and raw results under ignored .autopod-data/validation-evidence/.

### Success criteria

Automated:
- [x] New and selected existing public cases pass against unchanged product source.
- [x] Frozen assertions/source identities, actual runtime/SQLite and raw before evidence recorded.

Manual: None required for this local headless compatibility extraction.

## Phase 2: extract and prove collection contracts

Perform the exact two-file product move; public assertions remain byte-identical.
Add direct tests importing the actual factory. Use real collectors/store in isolated
temporary directories for successful and rejected-path cases. Recreate the store
on the same directory and read bytes/list refs to verify durable filesystem effects.
Use existing module spies only for otherwise unreachable collaborator throws;
restore them and distinguish contract injection from actual filesystem behavior.

Direct matrix:
- No side effects at construction; no-op gates; missing store/worktree/container;
  target-specific factory lookup; exact argument and podId-versus-pod.id forwarding.
- Host-before-sync byte preservation, mixed facts, precomputed gates under mutation,
  post-sync smoke/fact refs, missing files, absolute/relative/uppercase PNG gates,
  allowed host screenshots and symlink/path escape rejection using actual collectors.
- Duplicate page paths and ref identity, preexisting refs, partial storage and
  original result mutation, missing-count warnings and exact activity ordering.
- All sandbox receipt flag combinations; non-sandbox incoming true/false; thrown
  checkpoint/factory/sync; elapsed formatting and messages with controlled Date.
  Do not use sleeps. Verify captured store/resolver and late factory.get method lookup.
- Host/smoke/fact thrown collection, resolver errors, per-file store failures and
  info/warn/activity/formatting failures inside and outside the current catches.
  Preserve which later steps execute, returned flag or escaping error, and partial
  refs/bytes. Do not reinterpret a swallowed per-file failure as a thrown collector.

Manager tests prove persistence/deletion-guard/outer-catch wiring; direct tests prove
filesystem and collaborator behavior. No new SQLite ledger is introduced. Keep
existing real SQLite manager checks and repository suites rather than inventing an
unrelated durable-admission proof. Record actual movement/line counts and verify
all other baseline package/script files unchanged.

### Success criteria

Automated:
- [ ] Frozen public checks pass unchanged after extraction.
- [ ] Actual factory/collector/store byte/ref and failure-boundary checks pass.
- [ ] Exact movement and two-product/two-test path scope pass.

Manual: None required. Live container/provider behavior is outside this proof.

## Phase 3: qualify frozen final source

Use established ignored Node 22.23.3 / pnpm 9.15.4 launcher, confirming the actual
child runtime and opened SQLite. Freeze all final package/test/script hashes, compare
after qualification, and retain raw commands/exits/counts/skips and failures.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'validation evidence compatibility|surfaces ordered post-review finalization|collects synced evidence after a verified post-validation checkpoint'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/validation-evidence.test.ts
    npx pnpm exec biome check --files-max-size=2097152 packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/validation-evidence.ts packages/daemon/src/pods/validation-evidence.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Run the predecessor's explicit 48-file affected set plus four verified/new paths,
without name filters (52 suites total):
- src/pods/validation-evidence.test.ts (new in Phase 2).
- src/validation/screenshot-collector.test.ts.
- src/pods/screenshot-store.test.ts.
- src/validation/screenshot-artifacts.test.ts.

Save the fully expanded command. Full validation must run uncached with successful
frozen install, unchanged lockfile, lint, build, supported declaration typecheck,
tests, audit and secret scan. SQLite stays enabled. Supplemental semantic checking
covers new test boundaries without claiming old broad-test typing was repaired.

Carry documented process-only harness settings: maintenance.auto=false avoids the
reproduced Git lock-file scan race; task npx adds only --files-max-size=2097152 to
root lint so the manager test is processed. No rules/file selection disabled and no
repository/global configuration changes. If unrelated audit-clock or other failures
recur, retain and investigate before an unchanged rerun; no assertion suppression.
No passing results are inherited from slice 9.

Review diff/movement, recheck frozen hashes, update this plan with actual results,
commit/push verified increments, then verify clean worktree and remote identity.

### Success criteria

Automated:
- [ ] All 52 affected suites pass with SQLite and no new skips.
- [ ] Full uncached pipeline passes under the documented qualification environment.
- [ ] Scoped lint/whitespace, new-test semantic diagnostics, hashes and movement review pass.
- [ ] Final plan/evidence records actual results, limitations and pushed identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public baseline proves current ordering and manager wiring with real local evidence;
direct tests prove original object mutations and actual stored bytes using unchanged
collectors/store. Existing filesystem-security and artifact-publication suites protect
adjacent behavior. Controlled sync/checkpoint seams do not prove live Docker/Azure.

Keep existing I/O, collector passes, checkpoints and internal awaits. One extracted
async boundary is added before persistence; no performance improvement, new atomicity,
fencing, crash recovery or cross-process guarantee is claimed. No schema/API migration.
Revert manager wiring and module together. Integration and deployment are separate work.

## References and next action

Research: ../research/2026-10-18-pod-manager-validation-evidence.md.
Predecessor: 2026-10-17-pod-manager-validation-execution.md (complete).
Sources: pod-manager.ts:13602–13723, :13724 and :14187; validation/screenshot-collector.ts;
pods/screenshot-store.ts; pods/workspace-preservation.ts and workspace-transfer.ts.

The user explicitly approved this plan and all three phases together.
Next action: characterize the unchanged product before extraction.

## Phase 1 evidence

16 new public cases and two selected existing cases pass against unchanged product:
18 passed, 980 name-filtered. Real filesystem stores prove host bytes survive sync,
post-sync smoke/fact refs precede persistence/publication, best-effort failures,
verified/unverified/throwing checkpoint flags and local sync failure control the
later deletion guard. A held-write terminal transition pins current persistence
before the existing terminal check, without claiming a stronger ownership fence.

All 1,963 baseline package/script identities are recorded; only the test file changed.
Public assertions are frozen byte-for-byte. Node 22.23.3 opens SQLite 3.49.2. Scoped
Biome and supplemental semantic checking of the new group pass with zero warnings
or diagnostics. Initial one-case failure was a fixture using nonexistent updateStatus;
use the actual update API. Required page/fact fields were completed before freeze.
Raw initial failures and final passing results are retained privately.
