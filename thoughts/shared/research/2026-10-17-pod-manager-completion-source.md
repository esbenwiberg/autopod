---
date: 2026-10-17T21:49:10+02:00
researcher: Codex
git_commit: d804b1da21af7d26ccbc14e5484bc67a43d528e6
branch: codex/pod-manager-workspace
repository: autopod
topic: Source preparation inside worker completion
status: complete
last_updated: 2026-10-17
---

# Research: completion source preparation

## Research question

What source preparation remains in handleCompletion after the human-work gate,
and how does it feed completion and validation decisions?

## Summary

At d804b1da, pod-manager.ts is 18,006 lines. handleCompletion admits native Goal
and status, invokes the extracted human gate, handles artifact output, then prepares
source before choosing completion or validation. The contiguous preparation region
is pods/pod-manager.ts:11134–11347. It coordinates existing checkpoint, transfer,
recovery, auto-commit and diff-stat operations. Later decisions use its checkpoint,
canonical outcome and host proof together with a freshly loaded pod.

All references below are relative to packages/daemon/src/ at this baseline.

## Current flow

1. pod-manager.ts:11134 awaits syncSandboxSeriesHandover before source reads.
2. Sandbox with container and worktree calls checkpointSandboxWorkspaceForPod.
   The caller checks promoted, materialized and lineageVerified. An incomplete
   result emits activity and parks through parkOnWorktreeSyncFailure, then returns.
   A thrown checkpoint error propagates from handleCompletion.
3. Local/non-sandbox with container and worktree calls syncWorkspaceBack. A false
   pushed result still permits auto-commit but changes maxDeletions to zero.
   Sync rejection invokes tryRecoverAfterWorkspaceSyncFailure(pod, err, auto-commit).
   False recovery parks and returns; true recovery restores the normal threshold.
   Missing container/worktree skips this sync block and leaves both booleans true.
4. Sandbox requires worktree, startCommitSha and captured checkpoint. Missing
   evidence logs existing proof/decision telemetry, parks and returns. It calls
   classifyCanonicalDiff with startCommitSha and checkpoint commit/tree. An
   unavailable classification logs, parks and returns. Success persists statistics
   and retains host head/tree. A thrown classification or update error propagates.
5. Local worktree calls commitPendingChangesWithGeneratedMessage using resolved
   execution settings and pod.model. The normal deletion threshold is 100; a failed
   push selects zero. DeletionGuardError with a container attempts live extraction
   recovery; successful recovery retries auto-commit with threshold 100. A retained
   guard marks compromised state via the shared helper and transitions only a
   currently running pod to failed, then returns.
6. Ordinary first/retry commit errors are logged and can continue to diff statistics.
   Recovery rejection propagates. Profile resolution for the first commit is outside
   its try block. The later profile resolution, getDiffStats and local stats update
   share a catch that logs and continues with stored statistics on failure.
7. getDiffStats receives baseBranch ?? (defaultBranch ?? main) plus startCommitSha
   when present. Local missing worktree skips both commit and diff statistics.

## Connections and shared helpers

- workspace-preservation.ts supplies checkpointSandboxWorkspaceForPod; existing
  per-pod checkpoint overlap handling remains there.
- workspace-transfer.ts supplies syncWorkspaceBack/recoverWorktreeFromContainer.
- pod-manager.ts:5665 tryRecoverAfterWorkspaceSyncFailure is also used by validation.
  It logs recovery and clears compromised/preSubmitReview after successful transfer.
- pod-manager.ts:6065 handleDeletionGuardError uses the shared DeletionGuardError
  constructor, marks compromised state and emits its existing event/activity.
- pod-manager.ts:6199 parkOnWorktreeSyncFailure retains resources and moves a
  running/validating pod to failed. It is shared beyond handleCompletion.
- Existing transition, executionForPod and container-manager lookup are shared.
- artifact-finalizer.ts is an existing typed factory with narrow injectable helpers.

## Downstream decisions

pod-manager.ts:11349 onward reloads the pod and execution settings. It chooses
no-change completion, failed no-change Rework, validation bypass or validation,
using fork/scheduled/Rework flags and validation settings. A changed sandbox forces
blocking validation. Successful finalization telemetry and these decisions follow
source preparation. They are distinct from the preceding failure-proof telemetry.

The artifactCompletionRuns map is also read by getArtifactResumeObservation at
:17021. Artifact dispatch/coalescing is therefore connected to resume observation,
beyond the source preparation region. Interactive completion uses a separate
coordinator. None is part of source preparation.

## Git behavior and existing tests

- LocalWorktreeManager.classifyCanonicalDiff at worktrees/local-worktree-manager.ts:838
  verifies the base exists and host HEAD/tree match expected proof, then uses the
  normalized base-to-HEAD diff. Missing base, proof mismatch and Git failure return
  different unavailable codes. It does not derive zero from a failed proof.
- getDiffStats at :794 differs: it combines committed and uncommitted stats and can
  return fail-soft zeros. Normalized diff exclusions include pnpm-lock.yaml and
  mode-only changes. This distinction is present in the current code.
- commitPendingChangesWithGeneratedMessage at :1211 stages actual files, generates
  a message and calls commitStagedChanges. The latter resets the index to HEAD
  before throwing DeletionGuardError when deletions exceed its threshold. It does
  not restore deleted working files. Ordinary commit errors need not roll back
  source/index changes.
- auto-commit-message.ts calls createProfileAnthropicClient and can use a deterministic
  heuristic when that helper returns no_credentials. Git operations remain real
  when only the provider helper is controlled in tests.
- pod-manager.test.ts:12202 onward covers no-change completion, sandbox changed/net-zero,
  unavailable proof, start/base distinction and telemetry. :22005 onward covers
  deletion guard, sync recovery, checkpoint selection and blocked completion.
- local-worktree-manager.test.ts controls Git commands; local-worktree-manager.git.test.ts
  uses real private repositories. auto-commit-message.test.ts and the worktree manager suites cover the existing
  commit/diff behavior. Prior workspace slice tests cover transfer and
  checkpoint implementations.

## Historical context and evidence state

Slice 4 extracted the human-work hold and passed 1,004 affected tests plus the full
pipeline: 7,336 Vitest and 35 Node script tests. Its 10 existing skipped cases were
Docker/platform/live-model gates. Current managed worktree was clean on inspection.
No product source or tests were changed and no tests were run for this research.

## Open questions

None. The companion plan selects the next bounded extraction.
