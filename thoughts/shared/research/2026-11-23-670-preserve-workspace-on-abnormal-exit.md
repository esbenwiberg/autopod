---
date: 2026-11-23T08:03:12+00:00
researcher: Claude (regional-mongoose)
git_commit: 5e544da39d09884dc6538895eb36724d7fd34ce6
branch: fix/670-preserve-workspace
repository: autopod
topic: "Where is a worker's uncommitted workspace lost when an agent run ends abnormally (#670)?"
tags: [research, codebase, pods, workspace-preservation, provider-continuation, resume, rework]
status: complete
last_updated: 2026-11-23
last_updated_by: Claude (regional-mongoose)
---

# Research: worker workspace on abnormal agent exit (#670)

## Research Question

When a worker run ends abnormally (fatal provider/quota/unknown runtime error, thrown error, provider-limit pause), what happens to the uncommitted and untracked source in the container? Where is the container removed, how is `Source saved` recorded, and how does `ap resume` route a pod that failed during the agent stage?

## Summary

- **Local Docker keeps the agent's edits only in the container.** The agent works in the container's overlay `/workspace`. The host worktree is bind-mounted at `/mnt/worktree` and receives the edits only through `syncWorkspaceBack` (`pods/workspace-transfer.ts:75-91`, strategy comment at `:172-191`).
- **The failure path preserves sandbox pods only.** After `consumeAgentEvents` returns `'failed'`, `agent-process-workflow.ts:740-742` calls `preserveSandboxAfterAgentFailure(podId, 'fatal agent exit')` and then `releaseZeroWorkFailure`. The thrown-error path does the same at `:845-851`. `preserveSandboxAfterAgentFailure` returns immediately for anything that is not a sandbox (`workspace-preservation-recovery.ts:23`).
- **The failed Docker container is retained, but rework removes it without syncing.** Forced rework (`validation-trigger-workflow.ts:291-330`) calls `preservePodWorkspace` only when `executionTarget === 'sandbox'` (`:299-320`). It then calls `cleanupContainer(pod, 'Rework')`, which uses `cm.kill`, which on Docker stops and force-removes the container (`containers/docker-container-manager.ts:690-735`). It sets `recoveryWorktreePath = pod.worktreePath` (`:331-343`), so the new container mirrors the **host** worktree (`provisioning-workspace-population.ts:97-106`) and never sees the uncommitted container-only edits. This matches the #644/spicy-cockroach incident: the Phase 1 commit survived and the uncommitted Phase 2 was lost.
- **The provider-limit path syncs before teardown but records nothing.** `handleProviderLimit` (`provider-continuation.ts:225-318`) runs `syncWorkspaceBack`, then `capturePreparedDependencies` (#644), then `cm.kill`. If the sync fails it returns `'not_queued'` before the kill, so the container is retained, but nothing durable or operator-visible records the failure beyond a log line (`:254-257`). The journal's `sourcePreservedAt` is never written. `continueProvider` has the same order (`:521-565`) and throws `PROVIDER_CONTINUATION_UNSAFE` on failure.
- **`Source saved`** is `finalization.sourcePreservedAt`. It is written only through `completionJournal.mark(pod, phase, true)` (`completion-journal.ts:120-136`, `COALESCE`, never cleared). Current writers: the budget stop (`agent-event-consumption.ts:1008-1014`), the human-gate holds (`completion-human-gate.ts:48,86,114`), the artifact finalizer (`artifact-finalizer.ts:121`) and stalled-worker recovery (`stalled-worker-recovery.ts:513`). The ordinary agent-failure path and the provider-limit path never write it. The CLI prints `Source saved: <ts | not verified>` only when `agentSettledAt` is set (`cli/src/commands/pod.ts:889-897`).
- **Resume has no agent-stage gate.** `continuation-controls.ts:resumePod` (`:226-522`) sends every `failed` pod that clears its generic gates to Path 1 (push + PR, when the last validation passed) or Path 2 (`revalidateSession({force:true})`, validation only). Nothing checks whether the failure happened in the agent stage. The precedent for such a gate is `assertBudgetCodingNotInterrupted` (`budget-stop.ts:20-27`), called at `continuation-controls.ts:268`.

## Detailed Findings

### Agent terminal outcome handling
- A fatal or unverified error event classifies the failure, then either transitions to `paused`/`provider_limit` (definitive quota, or account failover) or to `failed` (`agent-event-consumption.ts:755-818`). Thrown errors set `outcome='failed'` with category `unknown` (`:823-850`).
- The `finally` block closes the provider attempt, calls `handleProviderLimit` for definitive quota (`:877-891`) and handles account failover (`:892-923`). It records the run outcome through `taskExecutions.finishRun(taskRunId, recordedOutcome, category)` (`:959-967`), which goes to the `task_agent_runs.outcome` column (`db/migrations/165_task_executions.sql:15-26`), and records the worker retry (`:969-990`).
- The verified token-budget stop is the one terminal path that already runs `preservePodWorkspace`, followed by `completionJournal.mark(..., 'ready', true)` (`:1000-1027`).

### Preservation primitives
- `createWorkspacePreservation().preservePodWorkspace(pod, reason)` (`workspace-preservation.ts:48-91`):
  - Sandbox: a verified checkpoint.
  - Local: `syncWorkspaceBack` with the pod's container/worktree under `captureValidationMutationGuard` authority (`pod-manager.ts:720-728`).
- `syncWorkspaceBack` (local) works as follows:
  - Pushes container commits to the bare repo, with the alternates path validated against the daemon-derived path.
  - Copies `/workspace` into staging, copy-first then delete-after, with `WORKSPACE_SYNC_EXCLUDES`. The exec has a 120 s timeout.
  - Falls back to the Docker archive API on any exec failure, which also works for stopped but not yet removed containers (`workspace-transfer.ts:377-389`).
  - Bounded engine-stall retries are `[5s, 15s]` (`:138-170`).
- `preserveSandboxAfterAgentFailure` (`workspace-preservation-recovery.ts:21-56`) checks that no run is active, validation is settled, the container status is `running`, and the lifecycle, container and status are unchanged. It then calls `preservePodWorkspace`. On failure it emits an activity line, retains the sandbox and logs. It never writes the journal.
- **The guards run when the preserved tree is committed.** Completion auto-commit (`completion-source.ts:144-285`) applies the deletion guard (`maxDeletions` is 100, or 0 when sync or push failed; `local-worktree-manager.ts:1674-1691`) and `AutoCommitIgnoreError`. Secret scanning is a push/delivery checkpoint (`security/scan-policy.ts:117-136`), not an auto-commit step. Sync-back to the host worktree does not commit. It makes the host tree equal to `/workspace` minus the sync excludes.

### Container removal
- After an agent failure the container stays, except for `releaseZeroWorkFailure`, which handles provider-account refusals before any work (`zero-work-failure-release.ts:41-106`).
- Removal happens later through:
  - rework (`validation-trigger-workflow.ts:328`)
  - delete (`workspace-deletion.ts:119`)
  - the daemon-restart reconciler (`local-reconciler.ts:351,391,414`)
  - provider continuation (`provider-continuation.ts:261-287, 521-565`)
- The sandbox terminal reaper covers only `complete`/`killed` pods (`sandbox-terminal-reaper.ts:36-39`).

### Rework
- Admission: `api/routes/rework.ts:28-101` → `assertCanRework` (`continuation-controls.ts:184-226`). For a nonretryable or unknown prior failure, the worker-retry preview throws `Unchanged or unverified nonretryable worker inputs…` (`task-retry-ledger.ts:387-391`). `ap authorize-retry --stage worker` grants it.
- Execution: `validation-trigger-workflow.ts:291-420`:
  1. Increment the generation.
  2. Preserve (sandbox only).
  3. Kill the sidecars, container and network.
  4. Set `recoveryWorktreePath`.
  5. Queue.
- Re-provisioning reuses the host worktree when its gitlink and bare metadata survive (`provisioning-workspace.ts:392-430`), then mirrors `/mnt/worktree` into the fresh `/workspace`.

### Resume
- CLI: `cli/src/commands/pod.ts:626-640` → `POST /pods/:id/resume` → `pod-manager-facade.ts:934-963` → `continuation-controls.ts:resumePod`.
- Gates in order:
  1. Goal, termination, publication, infrastructure, guidance, budget-coding.
  2. Artifact collection.
  3. Fix delivery.
  4. Status (`failed`/`review_required`).
  5. Sandbox startup retries.
  6. Worktree present and not compromised.
  7. Azure sandbox infrastructure restart.
  8. `assertValidationExecutionSettled`.
  9. Path 1, then Path 2.
- `Review source could not be read consistently` comes from `validation-review-source.ts:146-197` on the revalidation path, which is what the incident hit.
- `pausedResumeHint` (`continuation-controls.ts:53-60`) already points `paused`/`provider_limit` pods to `ap continue-provider`. `continue-provider --primary` accepts `failed` pods (`provider-continuation.ts:359-…`).

### Finalization storage constraint
- `pod_finalizations` has a `task_history_pod_finalizations` archive created as `SELECT * … WHERE 0`. A `retained_pod_finalizations` view unions the two with `SELECT l.* … UNION ALL SELECT h.*` (`db/migrations/177_task_history_archive.sql:46-51`), and `task-history-archive.ts:12` archives the table. Adding a column to `pod_finalizations` alone would break that union.

## Code References
- `pods/agent-process-workflow.ts:740-742, 845-851`: failed-outcome follow-up (sandbox-only preservation, zero-work release).
- `pods/workspace-preservation-recovery.ts:21-56`: `preserveSandboxAfterAgentFailure`.
- `pods/workspace-preservation.ts:48-91`: `preservePodWorkspace`.
- `pods/workspace-transfer.ts:75-91, 214-390`: `syncWorkspaceBack`, archive fallback.
- `pods/validation-trigger-workflow.ts:291-345`: forced rework preservation and kill.
- `pods/provider-continuation.ts:225-318, 521-565`: provider-limit sync, then capture, then kill.
- `pods/completion-journal.ts:120-136`: `mark(..., sourcePreserved)`.
- `pods/continuation-controls.ts:226-522`: `resumePod`.
- `pods/budget-stop.ts:20-27`: precedent "Resume cannot finish interrupted coding" gate.
- `pods/task-execution-ledger.ts:67-100, 654-680`: run ledger API (`hasSettledRun`).
- `cli/src/commands/pod.ts:836, 889-897`: Failure / Source saved display.

## Test templates
- `pods/workspace-preservation-recovery.test.ts` (with `createWorkspaceFixture` in `test-utils/workspace-recovery-helpers.ts`).
- `pods/provider-continuation.test.ts` (`fixture()` `:40-187`, order assertions `:455-477`, sync failure `:379-391`).
- `pods/continuation-controls.test.ts:48-59` (resume rejection pattern).
- `pods/pod-manager.test.ts` `describe('resumePod — token-free escape hatch for failed pods')` (~22529).
- CLI `cli/src/commands/pod.test.ts`.

## Related Research
- `thoughts/shared/plans/2026-11-22-644-preparation-timing.md`: #644 teardown capture hook (`capturePreparedDependencies` after sync, before kill).

## Open Questions
None for current-state behavior.
