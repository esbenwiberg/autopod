# Preserve worker workspace on abnormal exit (#670): implementation plan

## Overview

When a worker run ends abnormally, the daemon must preserve the container's uncommitted and untracked source in the host worktree before anything removes the container. Abnormal ends are: fatal provider, quota or unknown runtime error, a thrown agent error, or a provider-limit pause. The daemon must also record whether preservation happened (`Source saved`). If it did not, it must say so and keep the container. Separately, `ap resume` on a pod that failed in the agent stage must refuse the validation-only path and point to `ap rework` or `ap continue-provider`.

Research: `thoughts/shared/research/2026-11-23-670-preserve-workspace-on-abnormal-exit.md`.

## Current State Analysis

- **Agent failure preserves only sandbox pods.** It goes through `preserveSandboxAfterAgentFailure`, which returns early for local Docker (`workspace-preservation-recovery.ts:23`). Callers are at `agent-process-workflow.ts:740-742, 845-851`.
- **Forced rework removes the Docker container without syncing.** It preserves only sandbox pods (`validation-trigger-workflow.ts:299-320`), then calls `cleanupContainer`, and on Docker `kill` means stop plus force-remove. This is where the incident lost Phase 2.
- **The provider-limit path syncs but records nothing.** `handleProviderLimit` and `continueProvider` already sync before the kill. A failed sync retains the container, but nothing records the failure for the operator, and success never writes `sourcePreservedAt` (`provider-continuation.ts:244-287, 521-565`).
- **`Source saved` is written by `completionJournal.mark(pod, phase, true)`.** The failure and provider-limit paths never call it (`completion-journal.ts:120-136`).
- **Resume has no agent-stage gate.** It routes any failed pod to push+PR or to validation only (`continuation-controls.ts:466-521`).
- **No migration.** `pod_finalizations` is mirrored by `SELECT *` archive/union views (`177_task_history_archive.sql:46-51`), so adding a column there is not safe. This plan needs no migration.

## Desired End State

1. **Fatal or thrown worker failure on local Docker, container still present.** The daemon runs `preservePodWorkspace`, which calls `syncWorkspaceBack`, before `releaseZeroWorkFailure` or any later teardown. On success, `finalization.sourcePreservedAt` is set, so `ap status` shows `Source saved: <ts>`. Sandbox pods keep their checkpoint behaviour and now also record `sourcePreservedAt` on success.
2. **Preservation fails.** The container is retained, and `failureReason` gets `Workspace preservation failed: <detail>. Original container retained; …` (shared marker constant). `ap status` prints `Source saved: NOT saved — original container retained (see Failure)`.
3. **Forced rework of a failed local Docker pod.** Rework preserves the old workspace (the same idempotent sync) **before** `cleanupContainer`. If preservation fails, rework throws `WORKSPACE_SYNC_FAILED` and retains the container, as sandbox already does. If Docker reports the container `deleted`, rework proceeds from the host worktree and emits an explicit activity line. The next attempt starts from the preserved host tree through `recoveryWorktreePath`.
4. **Provider-limit pause and operator `continue-provider`.** After a successful sync, `sourcePreservedAt` is recorded. A failed sync records the explicit preservation failure on the pod, and the container is retained (already true today).
5. **`ap resume` on a failed pod whose latest worker run in the current lifecycle ended `failed`,** with no validation since (journal phase not `finalizing`/`finished`), throws `409 AGENT_STAGE_FAILED`. The message names `ap rework <id>` and `ap continue-provider <id> --primary`. It neither revalidates nor pushes. Validation-stage failures still resume as before.

### Key Discoveries
- `syncWorkspaceBack` is bounded: a 120 s exec, two engine-stall retries (5 s and 15 s), and an archive fallback that works on stopped Docker containers (`workspace-transfer.ts:138-170, 377-389`).
- Secret scanning guards push/delivery (`security/scan-policy.ts`). The deletion guard and `AutoCommitIgnoreError` guard the auto-commit at completion. Sync-back does not commit, so both guards still apply unchanged when the preserved tree is committed later.
- `task_agent_runs.outcome` is a durable, per-generation record of how the worker run ended (`165_task_executions.sql:15-26`).

## What We're NOT Doing
- **No auto-commit at failure time.** Preservation means syncing to the host worktree, matching every existing `preservePodWorkspace` user (budget stop, human gate, infrastructure hold). Uncommitted work stays uncommitted on the host, and the next container mirrors it. Commit guards stay at completion and push.
- No changes to #668's classifier, to `runtimes/claude-runtime.ts` or `pods/operator-messages.ts` (#648), or to `pods/validation-workspace.ts` or `pods/approval-controls.ts` (#663).
- No changes to operator `ap kill` (terminal `killed`), the daemon-restart reconciler, or delete. These are separate teardown owners.
- No DB migration. No desktop or mobile UI change, since the `finalization` shape is unchanged.
- No change to the zero-work provider-account release beyond ordering: preservation runs first.

## Implementation Approach

Reuse `preservePodWorkspace` everywhere. Add one small helper that records the outcome: on success `completionJournal` sets `sourcePreservedAt`, on failure `failureReason` gets the marker. Use it at the three teardown owners: agent failure, rework, and provider continuation. Add a resume gate modelled on `assertBudgetCodingNotInterrupted`.

## Phase 1: Preserve and record on agent failure and before rework teardown

### Changes Required

#### 1. Shared marker
**File:** `packages/shared/src/constants.ts`. Add `export const WORKSPACE_PRESERVATION_FAILED = 'Workspace preservation failed';` and export it from the index if needed.

#### 2. Outcome recorder
**File:** `packages/daemon/src/pods/workspace-preservation-outcome.ts` (new) plus a test.
- `recordWorkspacePreserved(podRepo, pod)`:
  - If the current-generation journal entry is missing, call `settle(pod)` first. Skip that step for artifact or `accept-findings` pods so `hasInterruptedArtifactCollection` routing does not change.
  - Then call `mark(current, entry.phase, true)`, which keeps the phase and sets `sourcePreservedAt`.
- `recordWorkspacePreservationFailure(podRepo, podId, detail)`:
  - Appends `${WORKSPACE_PRESERVATION_FAILED}: <sanitized detail>. Original container retained; do not delete the pod until the source is recovered; ap rework retries preservation before teardown.` to `failureReason`. This is idempotent: it does not append twice.
  -

#### 3. Agent failure path
**File:** `pods/workspace-preservation-recovery.ts`
- Rename `preserveSandboxAfterAgentFailure` to `preserveWorkspaceAfterAgentFailure`. Update the contract in `agent-execution-contracts.ts`, the wiring in `pod-manager.ts`, the callers in `agent-process-workflow.ts` and the test helpers.
- Accept `executionTarget === 'local'` as well. Keep every existing guard: active run, validation settled, lifecycle/container/status unchanged.
- Sandbox still requires `running`. Local accepts `running` or `stopped`, because the archive fallback covers a stopped container; `deleted` or `unknown` is recorded as a failure.
- On success call `recordWorkspacePreserved`. On failure call `recordWorkspacePreservationFailure` and keep the existing activity line and container retention.
- Ordering in `agent-process-workflow.ts` is unchanged: preserve, then `releaseZeroWorkFailure`.

#### 4. Rework before teardown
**File:** `pods/validation-trigger-workflow.ts:299-320`
- Extend the preservation block to `executionTarget === 'local' && pod.status === 'failed' && pod.containerId && pod.worktreePath`.
- For local, first read `cm.getStatus`:
  - `deleted`: skip, and emit `Old container no longer exists — Rework continues from the host worktree; container-only changes could not be recovered.`
  - `unknown`: throw `WORKSPACE_SYNC_FAILED`. The container is retained.
- On success call `recordWorkspacePreserved` against the pre-increment pod generation's journal entry, so it is visible in history. On failure keep the existing `WORKSPACE_SYNC_FAILED` throw.

### Success Criteria
#### Automated Verification
- [x] `workspace-preservation-recovery.test.ts`:
  - A local failed pod calls `preservePodWorkspace` and `finalization.sourcePreservedAt` is set.
  - A preservation error leaves `failureReason` containing the marker, keeps `containerId`, and never calls `cleanupContainer`.
  - A sandbox pod records `sourcePreservedAt` too.
  - The active-run guard is unchanged.
- [x] Workflow-level test, in the existing pod-manager or validation-trigger suite:
  - A failed local pod with a container is reworked. A mock `syncWorkspaceBack` writes an untracked file into the worktree. That sync runs before `cleanupContainer`, `recoveryWorktreePath` equals the worktree, and the file is present.
  - When sync fails, rework rejects with `WORKSPACE_SYNC_FAILED`, the container is not killed and `containerId` is unchanged.
- [x] Agent-process path: a fatal `error` event with an unknown or non-definitive quota classification on a local pod leads to preservation, `sourcePreservedAt` is set, and the call happens before `releaseZeroWorkFailure`.
- [x] `npx pnpm --filter @autopod/daemon exec vitest run <touched suites>` passes.

## Phase 2: Provider-limit and continue-provider record preservation

### Changes Required
**File:** `pods/provider-continuation.ts`
- In `handleProviderLimit`, after a successful `syncWorkspaceBack`, call `recordWorkspacePreserved(podRepo, source)` before `capturePreparedDependencies` and the kill.
- On sync failure, call `recordWorkspacePreservationFailure` and emit an activity line. The function still returns `'not_queued'` with the container retained.
- If `containerId` is set but `worktreePath` is not, keep today's behaviour. There is no git source to sync (artifact or no-repo pods).
- In `continueProvider`, after the sync succeeds, record preservation. On failure the existing `PROVIDER_CONTINUATION_UNSAFE` throw keeps the container, and the failure is also recorded on the pod.
- Inject `podRepo.completionJournal` through the existing `podRepo` port. Inject nothing else.

### Success Criteria
#### Automated Verification
- [x] `provider-continuation.test.ts`:
  - On a definitive-quota provider limit, the sync's untracked file is present in the worktree, `sourcePreservedAt` is set, and the order is `['abort','sync','capture','kill']`. The existing order is preserved.
  - When sync fails, nothing is killed, `containerId` is retained, and `failureReason` has the marker.
  - `continueProvider` records `sourcePreservedAt`.
- [x] Suites pass.

## Phase 3: Resume refuses agent-stage failures; CLI shows the preservation state

### Changes Required
- **`pods/task-execution-ledger.ts`:** add optional `latestRun?(podId, generation): { outcome, failureCategory, endedAt, cycle } | null`, reading `task_agent_runs` ordered by `cycle DESC, started_at DESC`.
- **`pods/continuation-controls.ts`:**
  - Add `assertNotInterruptedAgentStage(pod)`, called in `resumePod` right after the worktree and compromised checks and the Azure sandbox infrastructure block, before Path 1 and Path 2. It throws `AutopodError(…, 'AGENT_STAGE_FAILED', 409)` when all of these hold:
    - `pod.status === 'failed'`
    - the latest run for `pod.lifecycleGeneration` has `outcome === 'failed'`
    - `finalization` is null, or its phase is not `finalizing`/`finished`
  - Message: `Pod <id> failed during the agent stage; validation-only Resume cannot finish unfinished work. Run: ap rework <id> (continues coding from the preserved workspace) or ap continue-provider <id> --primary (continue on the profile primary provider).` Append the source state: `Source saved: <ts>` or `Workspace preservation was not verified — inspect ap status before Rework.`
  - The artifact-collection and fix-delivery paths stay above the gate.
- **`packages/cli/src/commands/pod.ts:889-897`:**
  - Print `Source saved:` whenever `finalization` exists and any of these hold: `agentSettledAt` is set, `sourcePreservedAt` is set, or `failureReason` includes the marker.
  - When `sourcePreservedAt` is null and the marker is present, print `NOT saved — original container retained (see Failure)`.

### Success Criteria
#### Automated Verification
- [x] `continuation-controls.test.ts`:
  - A failed pod whose latest run outcome is `failed` makes resume reject with `AGENT_STAGE_FAILED`, and the message contains `ap rework` and `ap continue-provider`. `revalidateSession`, `pushAndCreatePr` and `enqueueSession` are not called.
  - A failed pod whose run `completed` (validation failure) still revalidates.
- [x] `task-execution-ledger` unit test for `latestRun`.
- [x] CLI `pod.test.ts`: the status output renders both `Source saved` variants.
- [x] Typecheck and build: `npx pnpm --filter @autopod/shared build && npx pnpm --filter @autopod/daemon exec tsc --noEmit && npx pnpm --filter @autopod/cli exec tsc --noEmit`.
- [x] `npx pnpm lint` (Biome). Daemon and CLI affected suites pass. The broader `npx pnpm test:pr` runs once at the end, in the foreground.

## Testing Strategy
- Unit tests at each owner, using the existing fixtures (`createWorkspaceFixture`, the provider-continuation `fixture()`, the continuation-controls `fixture()`).
- The acceptance flow through rework uses a mock `syncWorkspaceBack` that materialises an untracked file in the real temporary worktree, to show the next attempt's `recoveryWorktreePath` holds the preserved tree.
- Real Docker is unavailable in the pod. The live-Docker end-to-end check is deferred to the operator.

### Manual Testing Steps (operator, local Docker)
1. Start a pod, let the agent write uncommitted files, then force a fatal runtime error (for example, revoke the provider key). Expect `ap status` to show `Source saved: <ts>` and the files to be present in the host worktree.
2. Run `ap resume` on that pod. Expect a 409 that names rework and continue-provider.
3. Run `ap rework`. Expect the new container to contain the files.

## Performance Considerations
One extra bounded sync per abnormal exit and per local rework of a failed pod. It is idempotent and costs seconds on typical repos.

## Migration Notes
No migration. The existing `sourcePreservedAt` column is used and the failure goes into `failureReason`. Rollback means reverting the code.

## References
- Issue #670, the incident on spicy-cockroach (#644).
- Research: `thoughts/shared/research/2026-11-23-670-preserve-workspace-on-abnormal-exit.md`.
- Precedents: the budget-stop preserve and mark (`agent-event-consumption.ts:1000-1027`) and the resume gate `assertBudgetCodingNotInterrupted` (`budget-stop.ts:20-27`).

## Implementation Notes (2026-11-23)

Approved on 2026-11-23 as option 1: sync-only preservation, no auto-commit, no migration. The operator added three notes, each folded in as listed:

1. A fatal error after `complete` in the same run (#648) is preserved. Covered by `abnormal-exit-preservation.test.ts`.
2. A failed preservation names the retained container and gives exact next steps (`ap rework`, manual copy, `ap kill`) in `failureReason`. `ap status` shows `Source saved: NOT saved`.
3. Committed per phase. Tests ran in foreground batches.

Deviations and refinements:
- **Predicate moved to its own module.** The resume-gate predicate lives in `pods/agent-stage-interruption.ts` (`isAgentStageInterrupted` and `assertAgentStageNotInterrupted`). It treats any non-`completed`, settled run (`failed`, `paused`, `stopped`) as interrupted.
- **Rework uses the same predicate.** Rework syncs a failed local worker only when its agent stage was interrupted. Validation-stage failures were already synced at completion, and re-syncing them could import validation-generated files.
- **Rework writes no journal receipt.** The generation increments before teardown, and the receipt from the failure-time preservation already exists.
- **Receipt after the infrastructure fence.** On the provider-limit path, `Source saved` is recorded only after the post-sync infrastructure fence. The fence tests now expect that receipt for holds that arrive after a completed sync.
- **Zero-work release guarded.** `releaseZeroWorkFailure` also refuses to remove a container whose preservation failed.
- **No separate `latestRun` unit test.** It is covered with real SQLite by `agent-stage-interruption.test.ts` and `continuation-controls.test.ts`.
- **Pre-existing failures.** Five `pod-manager.test.ts > approveSession` tests fail identically on the base commit `5e544da`. They are unrelated to this change.
