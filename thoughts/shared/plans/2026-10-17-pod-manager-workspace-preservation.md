# First workspace preservation extraction

Status: approved by the user ("Plan approved"); Phase 1 complete; implementation underway.
Baseline: 6e51d1ce9495235e6aac2e498393cd2dd9a0e66b (remote main verified 2026-10-17).
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Branch: codex/pod-manager-workspace.

## Overview and authority

The user accepted incremental pod-manager decomposition and the proposed sequence:
research the boundary, characterize it, extract a coherent operation, prove
compatibility, and integrate/reassess. This plan specifies the first small
extraction within the broader workspace workstream. The accepted strategy is not
recorded as approval of a previously nonexistent detailed implementation plan.

Move preservePodWorkspace, checkpointSandboxWorkspaceForPod and their direct
checkpoint promise map into a typed workspace-preservation factory. Keep existing
callers and all lifecycle policy in pod-manager. This creates an independently
testable preservation operation without also moving Docker transport, validation
reconciliation, or publication policy.

The user explicitly approved this concrete plan in the conversation after reviewing
the illustrated document. All three phases are authorized. No manual-verification
gate is required for this headless boundary.

## Current state analysis

See ../research/2026-10-17-pod-manager-workspace-preservation.md.

The manager nests preservation at :5657, checkpoint delegation at :5697 and the
direct-fallback map at :4005. Preservation selects between existing local transfer
and sandbox verified checkpoint behavior. An independent checkpoint controller
already owns durable records, sequence progression, retries and concurrency.

Shared Docker helpers have callers in provisioning and validation. Some sandbox
callers still use generic archive synchronization. Moving all workspace behavior
together would widen this compatibility extraction.

## Desired end state

- Public PodManager signatures and existing observable behavior remain the same.
- workspace-preservation.ts owns both preservation functions and one per-factory
  direct checkpoint map.
- pod-manager composes the factory once, using its existing transfer callback,
  container factory, optional controller/transport seam, logger and activity emitter.
- The module has no repository, status-transition, cleanup, credential, worktree
  publication, scheduler or public PodManager dependency.
- Before/after characterization produces the same results and resource outcomes.
- Existing controller, primitive and artifact behavior retains affected coverage.

A later extraction can move Docker transport behind the existing transfer callback.
That staged callback is composition, not permission for a module to import or call
the public manager.

## What we're NOT doing

- Change checkpoint keys, ordering, retries, sequence allocation or persistence.
- Add lifecycle fences, cancellation, timeouts or new cleanup decisions during movement.
- Convert generic sandbox sync callers to verified checkpoint callers.
- Move validation reconciliation, source/Git publication, provider continuation,
  artifact finalization, provisioning, approval or recovery-status policy.
- Change profiles, schemas, migrations, clients, runtime models or dependencies.
- Deploy, start real pods, publish PRs, merge main or modify concurrent checkout work.
- Claim in-memory duplicate suppression proves restart or cross-generation safety.

## Implementation approach

Add packages/daemon/src/pods/workspace-preservation.ts with a typed factory:
createWorkspacePreservation(deps), returning preservePodWorkspace and
checkpointSandboxWorkspaceForPod under their current names.

Dependencies:

- getContainerManager(target: Pod['executionTarget']): ContainerManager.
- syncWorkspaceBack(containerId, worktreePath, cm, podId, executionTarget):
  Promise<{ pushed: boolean }>, using existing domain types.
- workspaceCheckpointController?: Pick<WorkspaceCheckpointController, 'request'>.
- sandboxWorkspaceCheckpoint?: the existing checkpoint function signature.
- logger: Pick<Logger, 'info'>.
- emitActivityStatus(podId: string, message: string): void.

The default direct transport remains the actual checkpointSandboxWorkspace import.
The module must use type-only controller imports, have no runtime manager import,
and avoid a new shared service registry or circular dependency. PodManagerDependencies
keeps its existing supported optional seams.

Preserve the passed Pod snapshot, all awaited call boundaries, missing-workspace
result fields, unknown/stopped behavior, proof predicates, result identity, activity
strings, log fields, direct map key, controller-first fallback ordering, Date.now
timing and finally release exactly. Keep the map per factory instance.

Factory composition must finish before any public operation can run. Remove manager
imports only when no other caller needs them. Preserve typed imports still used in
PodManagerDependencies and other manager methods.

## Phase 1: characterize current public preservation behavior

### Changes required

Only packages/daemon/src/pods/pod-manager.test.ts.

Add a named 'workspace preservation compatibility' group using the existing
createTestContext harness, real SQLite repository, existing mock infrastructure,
and bounded deferred promises. Close each new context's database in finally.
Do not duplicate fixture factories in production or create new production test seams.

Cases:

1. Missing container or worktree: preservation fulfills with no infrastructure,
   activity or cleanup. Check each absent input independently.
2. Unknown sandbox: reject the existing unavailable error without checkpoint,
   recursive extraction or cleanup. A rejected start also propagates without capture.
3. Stopped sandbox: await start before checkpoint. A held start cannot publish
   success activity. Accepted proof emits the existing success activity.
4. Incomplete sandbox proof: parameterize promoted, materialized and lineageVerified
   separately, preserving the error/fallback message and retained resources/status.
5. Controller preference: supply an actual WorkspaceCheckpointController with narrow
   controlled collaborators; assert its stored result reaches the caller and the
   direct checkpoint seam is unused. Failed structured proof must not trigger direct
   fallback. Controller observation/capture rejection propagates.
6. Controller absent-result fallback: spy on a real controller instance's public
   request solely to return its documented result-optional decision shape; exercise
   the actual manager fallback, with no unsafe cast to bypass private class fields.
7. Direct duplicates: hold the direct checkpoint promise, start two public
   preserveWorkspace calls, and assert one capture. Release and await both. Repeat
   with rejection, then demonstrate a fresh explicit call can capture successfully.
   Assert observable operation counts, not promise-object identity or map internals.
8. Docker preservation: assert all original transfer arguments, existing activity,
   and no status/cleanup changes. Exercise success with pushed=false and rejection
   of both exec/archive paths. This checks caller interpretation, not just mocks
   repeating a new implementation's internal call order.

Use existing coverage for cleanup after successful preservation, sandbox retention
on failure and compromised-worktree recovery. Do not manufacture a failing baseline:
this phase characterizes existing behavior.

### Success criteria

Automated:
- [x] New cases pass before production edits, with exact base SHA and log retained.
- [x] Existing affected manager preservation/recovery cases pass.
- [x] Bounded waits are released/joined and DBs/timers/spies are disposed in finally.
- [x] Product source diff is empty in this phase.

Manual:
- None required for this headless compatibility boundary. No human acceptance claimed.

## Phase 2: extract preservation and checkpoint delegation

### Changes required

- Add packages/daemon/src/pods/workspace-preservation.ts.
- Update imports and factory wiring in packages/daemon/src/pods/pod-manager.ts.
- Remove precisely the two moved helper bodies and sandboxCheckpointRuns declaration
  from the manager, retaining all their existing callers.

Move the existing implementations rather than redesigning their algorithms. There
is no repository adapter in the new module. preserveSandboxAfterAgentFailure,
cleanupContainer, transition, ownsLifecycle, completion admission, forced-Rework
policy and recoverWorktree remain manager-owned.

Add packages/daemon/src/pods/workspace-preservation.test.ts only for the new material
boundary: run the factory directly with actual WorkspaceCheckpointController and
real temporary Git/bundle checkpoint infrastructure patterned after existing
sandbox-workspace-checkpoint.test.ts. This fixture uses a controlled local
ContainerManager adapter, actual Git/files and the real checkpoint primitive.
Verify report bytes and snapshot/head/tree identities match after preservation.
No Docker server, provider account or real remote is required.

Do not count a hand-built successful proof object as end-to-end source preservation.
Keep the public characterization as the manager-wiring oracle.

### Success criteria

Automated:
- [ ] Identical Phase 1 cases pass after extraction.
- [ ] Direct boundary case verifies actual materialized local Git/files.
- [ ] Source comparison confirms movement, with only typed composition adapters changed.
- [ ] New module has no runtime dependency on pod-manager or repository/status policy.
- [ ] Existing local and sandbox routing behavior, including legacy callers, is retained.

Manual:
- None required for this phase.

## Phase 3: qualify the combined change

Install frozen dependencies with Node 22 and pnpm 9.15.4 in the isolated worktree.
Record actual versions. Use npx as required by repository instructions. Prevent
a nested npx from switching the native SQLite ABI: run the validation pipeline
under the same pinned Node environment and inspect the actual child runtime.

Commands from repository root, with the pinned Node 22 selected:

    npx pnpm install --frozen-lockfile
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'workspace preservation compatibility'

After Phase 2, include the new factory suite and the existing affected suites:

    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/workspace-preservation.test.ts src/pods/pod-manager.test.ts src/pods/workspace-checkpoint-controller.test.ts src/worktrees/sandbox-workspace-checkpoint.test.ts src/worktrees/bare-push.test.ts src/pods/workspace-branch-publication.test.ts src/pods/artifact-preservation.test.ts src/pods/artifact-preservation.sandbox.test.ts src/pods/artifact-snapshot-receipt.test.ts src/pods/artifact-snapshot-inventory.test.ts src/pods/artifact-resume-observation.test.ts src/pods/completion-journal.test.ts src/pods/local-reconciler.test.ts src/pods/pod-lifecycle.e2e.test.ts

Also run scoped Biome and whitespace checks:

    npx pnpm exec biome check packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/workspace-preservation.ts packages/daemon/src/pods/workspace-preservation.test.ts
    git diff --check
    SKIP_DB_TESTS=0 ./scripts/validate.sh

Record checks, exits, test counts, name-filtered versus environmental skips, source
hashes and evidence paths. Failures or unavailable gates remain explicit. The
pipeline is required for final acceptance; running it is planned, not yet completed.

### Success criteria

Automated:
- [ ] Affected suites pass with SQLite explicitly included.
- [ ] Full validation passes on final product source.
- [ ] Before/after logs and actual source identities are retained.
- [ ] Diff review confirms no extra policy or externally visible behavior change.
- [ ] Final report states exact execution boundaries and skips.

Manual:
- No UI/manual judgment is required. A later deployment or real-pod acceptance
  session is a distinct action, not silently required or reported as completed.

## Testing strategy and evidence limits

Characterization protects public behavior and composition. Real Git/filesystem
testing protects the new source-preservation boundary. Existing controller tests
protect persistent sequence/retry behavior; unchanged manager tests protect cleanup
and lifecycle policy. Do not add tests merely asserting the extracted function is
called.

A locally reconstructed controller is not process-death proof. A controlled
ContainerManager adapter is not Docker/Azure proof. No existing transfer operation
becomes cancellable merely because it moved files. Any demonstrated defect outside
the compatibility contract is recorded with a reproduction for a separately scoped
fix; it is not hidden in the mechanical movement.

## Performance considerations

One factory and one map per manager replace the same existing map/functions. Preserve
lazy operation timing and Date.now sequence evaluation. No added I/O, retry, fingerprint,
scheduling or eager infrastructure call is planned. No speed claim is made.

## Migration and rollback

No schema, API, profile, stored record or configuration change. Module/wiring can be
reverted together without database rollback. Existing checkpoints and in-flight
operation semantics are preserved. Production deployment is outside this task.

## References

- Research: ../research/2026-10-17-pod-manager-workspace-preservation.md.
- Existing extraction pattern: 2026-10-15-artifact-finalizer-extraction.md.
- Broader campaign evidence: 2026-10-16-reliability-final-report.md.

## Next action

Proceed with Phase 2 under the recorded approval, then Phase 3. No PR publication,
main merge, deployment or real-pod run is part of this task.

## Implementation evidence: Phase 1

Seventeen public characterization cases passed against unchanged product source
at baseline 6e51d1ce; 674 other manager cases were name-filtered. Node 22.23.3,
pnpm 9.15.4, Vitest 4.1.11. Frozen installation and the daemon/dependency build
passed. Production manager bytes match git HEAD exactly. Each new case closes its
SQLite database and releases its held work. No real container or provider was used.

Private receipts and before-source/test copies are retained under
.autopod-data/workspace-preservation/: characterization-before.log,
characterization-before.json, characterization-before.test.ts, before-pod-manager.ts,
baseline-build.log and install.log. The next action is Phase 2 extraction.
