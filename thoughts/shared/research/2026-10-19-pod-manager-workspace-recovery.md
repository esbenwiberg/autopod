---
date: 2026-10-19T08:42:14+02:00
researcher: Codex
git_commit: c00a32d0871721658ef22019955109f478bc3e0c
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice31 workspace completion, recovery, deletion, retries and watchdog ownership"
tags: [research, codebase, pod-manager, workspace, recovery]
status: complete
last_updated: 2026-10-19
last_updated_by: Codex
---

# Slice31 research: complete workspace and recovery responsibility

## Question and baseline

Locate all remaining31 roadmap algorithms, shared state, live dependencies and dynamic
receiver calls after30 resource extraction. References are packages/daemon/src/pods/
pod-manager.ts at c00a32d0871721658ef22019955109f478bc3e0c. Manager is4,447lines/73public members.
30 implementation is committed/pushed/frozen while expanded qualification is running;
this report does not mark30 complete or introduce31 product changes. Exact source,
references and state are saved under .autopod-data/workspace-recovery/.

## Host fetch retries and infrastructure recovery

hostFetchRetryTimers(:859) is one per-instance Map. scheduleHostFetchRetry(:861–909)
compares prior git-fetch branch/purpose to increment attempts and chooses30s/120s/300s.
It saves retry identity/not-before/diagnostics, clears any old timer, creates an unrefed
replacement and emits original activity. On fire it deletes its entry, safely re-reads
and enqueues only a queued pod with matching source/not-before. No explicit global
retry timer cancellation service is present; replacement and callback own its cleanup.

hasDurableAgentExecutionEvidence(:911–934) checks worktree compromise, native conversation
ids, usage/cost, task summary, validation, PR and persisted terminal event. It reads live
eventRepo/providerAttemptRepo and falls back to recorded attempt ids/usage. It is shared
with dispatch, continuation and recovery rather than a replacement execution ledger.
sandboxInfrastructureFailure(:936–958) builds the original diagnostic record with time,
phase/safe-agent/recovery disposition and retry deadline.

tryRecoverTransientSandboxFailure(:960–1102) admits only sandbox setup/agent failures
owned by the captured lifecycle. Agent evidence/runtime observation blocks fresh worker
restart unless skipAgent validation-only recovery deliberately carries completed evidence.
Actual sandboxStartupRetries ledger, or legacy count fallback, enforces retry admission
with live backoff input. It increments lifecycle generation before killing the old
container, retains unconfirmed cleanup and checks generation/container after remote
cleanup. Confirmed cleanup closes the provider attempt, kills sidecars/network and
retains worktree as recovery path, increments recovery count, saves scheduled retry and
queues through live requeueSessionAfterCurrent or original setImmediate fallback to
live enqueueSession. No stronger termination or durable replay property is added.

## Recovery run state and branch source

infrastructureResumeRuns/artifactResumeRuns/artifactCompletionRuns(:1188–1190) are three
per-instance promise Maps shared with existing continuation/agent/completion workflow
owners. coordinateInteractiveCompletion(:1191–1192) is the original imported generic
coordinator instance, currently typed through Awaited<ReturnType<PodManager['completeSession']>>.
Its runtime factory initializer creates an in-process map; it coalesces same pod/
generation/request hash and refuses conflicting overlap with COMPLETION_IN_PROGRESS.
The imported interactive-completion-coordinator.ts removes only its own promise in
finally. Its existing generic argument is a type-level dependency on the public
manager; runtime behavior does not read the manager or invoke service effects.

forceWithLeaseAllowances(:1237) is a shared Set used by validation/update-from-base/
approval and deletion. Watchdog interval/unsubscribe bindings(:1299/:1301) start null.
resolveBranchSource(:1315–1359) is a complete original arrow binding. Non-single mode
returns parent; single mode requires series/id/PR owner, deterministically chooses a
matching PR owner or first recorded owner and logs ambiguity/redirect. Fix admission
captures the same function. There is no dynamic this or live dependency field here.

## Preservation guards and failure helpers

preserveSandboxAfterAgentFailure(:1681–1697) applies only to sandbox with container/
worktree; preservePodWorkspace precedes cleanupContainer and a failed preservation
logs/activity while retaining resources. tryRecoverAfterWorkspaceSyncFailure(:1699–1732)
requires both identities, reports original sync detail, invokes imported recovery, then
clears compromise/review state only on success. Resource and workspace-transfer owners
are called rather than reimplemented.

handleDeletionGuardError(:1749–1768) recognizes only DeletionGuardError, best-effort marks
compromise, emits deletion count/threshold event and original recovery activity. The
ownsArtifactCompletion(:1770–1784) predicate checks generation/container, running status,
no escalation and no queued guidance, with original optional removed-container/guidance
allowances. failInteractivePreservation(:1786–1793) records the original retained-resource
failure only while owned, then throws WORKSPACE_PRESERVATION_FAILED. failBranchPreservation
(:1795–1802) first asserts approval ownership, records/emits reason and throws the
original BRANCH_PRESERVATION_FAILED. These helpers enter existing completion/approval/
artifact owners through captured callbacks.

assertInteractiveCompletionCurrent(:1804–1833) checks guidance and current generation,
running interactive/output/branch/base/target/worktree/container identity, optionally
allowing already removed container; durable unanswered human decisions separately
block. Errors remain STALE_WORKSPACE_COMPLETION/HUMAN_DECISION_PENDING. Existing
createArtifactFinalizer composition(:1835 onward) captures ownsArtifactCompletion and
these workspace/resource operations. parkOnWorktreeSyncFailure(:1850–1864) marks compromise,
emits recovery guidance and transitions only running/validating to failed.

## Interactive promotion and completion

promoteToAuto(:2990–3133) is a144-line public async body without this. It checks original
interactive promotability, repository and skip-agent/output admission. Frozen launches
read live launchConfiguration.prepareWorker, derive worker task/output/handoff inputs
and transition handoff in the callback using frozen validation/advisory policy, then
enqueue. Legacy promotion preserves replacement-not-append handoff instructions,
optional skipAgent, worker-profile selection/snapshot and original handoff event/queue.
Existing container identity survives handoff for the recovery path.

completeSession(:3135–3357) is a223-line public body using the shared completion
coordinator and dynamic this.promoteToAuto/this.revalidateSession. It validates running
interactive state and full completion ownership inside the coordinated operation.
Non-branch requested promotion delegates to the actual receiver. Artifact output
preserves first; other outputs sync the original container/worktree, reject unavailable
preservation, run push scan and original default-branch protection, obtain host Git
auth and push with maxDeletions100/derived commit message. Successful push precedes
worktree cleanup; push error is retained as result while the original worktree survives.
All original ownership checks/await boundaries remain visible.

It then emits completion activity, calls bounded cleanup with release assertions,
allows removed current container, transitions complete/clears old preservation reason,
and uses live getSecret to load/deactivate recorded PIM groups best effort. Final
completion event is generation checked. A linked failed/review worker revalidates
through the dynamic receiver in detached original code only after successful push.
The public result is pushError/promotedTo; coalescing is in-process overlap protection,
not newly guaranteed durable effect replay.

syncWorkspaceBranch(:3359–3474) independently admits running interactive workspace with
worktree/branch, syncs container first and retains resources on sync failure. It lists
modified/untracked Markdown plus contract YAML paths via original git ls-files -z,
commits only those explicit handoff paths, obtains host credential and pushes without
completing or cleaning resources. An empty path list still pushes; before/after commit
log determines committed flag. Its errors return committed=false/pushed=false/error.
This policy differs from completeSession and remains separate.

## Recovery commands and manual fixes

preserveWorkspace(:3476–3478) awaits original preservePodWorkspace with default operator
recovery reason. quiesceSandboxAgent(:3480–3509) only probes a running attached sandbox,
executes the exact PID-file/TERM/wait/KILL script with5s timeout and throws for nonzero
exit. suspendSandboxForRecovery(:3511–3516) stops only running attached sandboxes.
cleanupPodResourcesForRecovery(:3518–3521) strictly kills sidecars then network.
These are public wrappers but their complete current bodies are part of31.

fixManually(:3546–3635) normalizes human/automation actor and admits failed/review/
validated workers. Frozen workers require verified execution termination and live
admitDerived, bind the dynamic createResolvedSession receiver and derive manual-fix
configuration from the original worker snapshot while clearing series/dependent/spec
metadata. Legacy path uses dynamic this.createSession with workspace output, same
branch/base and linked worker. Actor/task/instructions/creator propagation remains.
PodCreator currently is another manager-defined public type consumed by this method.

getArtifactResumeObservation(:4028–4050) reads live eventRepo, catches unavailability,
asserts termination/guidance and rejects active runs before calling observeArtifactResume
with actual recovery/completion map membership. It is read-only status projection and
never resumes work. Original imported observation type is already domain-owned.

## Durable deletion and operator escape hatches

deleteSession(:3678–3770) asserts durable task-execution deletion availability, admits
terminal/failed/review/killing and hashes the current test-pipeline config. It acquires
deletionOwnership, checks exact generation/status/container/target/worktree/runtime/
configuration before effects and each stage, and calls imported runDeletionCleanup
with25s stage allowance and original preview→sidecar→container→network→test branches→
worktree→runtime-state order. Sidecar/branch metadata is retained until final claim.
After verified cleanup it clears validation intent/force-lease state and deletes within
claim.finish. Missing or stale cleanup proof retains the row/resources. Imported durable
ledger/cleanup algorithms are existing collaborators, not replaced by this research.

forceComplete(:4069–4117) admits only failed, runs terminal bounded cleanup then saves
operator reason/time, transitions complete and triggers dependents. It intentionally
skips normal push/PR/merge. kickPod(:4119–4182) clears a stale queue entry and re-enqueues
queued work, or aborts validation/stops the existing container and force-fails active
states, with original actor/time/reason/error behavior. No dynamic this occurs in these.

recoverWorktree(:4332–4445) requires compromise and worktree. Sandbox resumes retained
container and accepts only checkpoint lineageVerified/promoted/materialized before
clearing compromise/review. Local path tries live extraction and guarded generated-message
commit; otherwise it falls back to restoreFromHead allowing tracked modification repair,
retains blockers/failure details and unrelated untracked work, then clears compromise
only on successful recovery. Native checkpoint/host Git adapters remain external effects.

## Watchdog and wake recovery

startStuckPodWatchdog(:4184–4319) is idempotent on its interval binding. It retains
interval/default/environment threshold and60s wake grace. Tick skips interactive pods,
uses freshest valid agent/heartbeat/start liveness or legacy timestamps, attempts
preview/container stop and re-reads running status before failing silent work. Interval
fires void tick; there is no new overlapping-tick serialization or drain guarantee.

Its event subscription tracks up to256 processed host-resumed timestamps, refreshes
grace even for replay and calls imported reconcileLocalSessions for local containers.
Live launchConfiguration.goals.get is read in that event path. Reconcile callbacks
resolve this.killSession and this.cleanupPodResourcesForRecovery dynamically; completion
re-publishes the same original timestamp with reconciled ids to avoid recursion.
stopStuckPodWatchdog(:4321–4330) clears/nulls interval and calls/nulls unsubscribe. It
does not cancel already dispatched async tick/reconcile work. Preserve those limits.

## Reference and construction inventory

Scope has27 complete named functions/methods, one complete branch-source arrow and nine
original binding initializers(including that arrow). Fifteen are public commands.
Only completeSession, fixManually and startStuckPodWatchdog use this, respectively
(promoteToAuto,revalidateSession), (createResolvedSession,createSession), and
(killSession,cleanupPodResourcesForRecovery). The receiver remains relevant inside
later coordinated/deferred/event callbacks.

Live fields: evidence eventRepo/providerAttemptRepo; infrastructure backoff/requeue/
enqueue; promotion/manual-fix/watchdog launchConfiguration; completion getSecret;
artifact observation eventRepo. Captured service instances, shared promise maps,
coordinator, force-lease Set, resource callbacks and branch resolver are separate
references. Full captured-reference inventory is stored, with exact line origins.
Current hoisted functions reference later initialized provider/resource/completion
callbacks, while startup delivery polling already captures cleanup/branch source.
State creation and binding availability therefore matter to source relocation.

## Existing tests and related artifacts

Existing suites include1,192 public manager cases; interactive completion coordinator,
workspace branch publication/preservation/transfer/checkpoint, artifact preservation/
resume/fences, local reconciler, deletion ownership/cleanup/ledger, task execution and
sandbox startup retry tests. They exercise real local SQLite/files/Git with controlled
remote adapters; no live Docker/Azure/provider acceptance is implied. Relevant paths
are packages/daemon/src/pods/{workspace-branch-publication,workspace-preservation,
workspace-transfer,workspace-checkpoint-controller,artifact-resume-observation,
local-reconciler,deletion-ownership}.test.ts and the current manager tests.

Related research:2026-10-19-pod-manager-resources-preview.md. Remaining roadmap and30
plan live in ../plans/. After31,32 owns admission/query/series,33 consolidates stable
contracts and<=1,500line composition/delegates,34 reconciles327baseline units/73public
members/all mutable owners and qualifies a final clean pushed frozen revision.
No31 product changes are made by this descriptive report.

## Exact declarations

| Kind | Symbol | Lines |
|---|---|---|
| function/method | `scheduleHostFetchRetry` | 861–909 |
| function/method | `hasDurableAgentExecutionEvidence` | 911–934 |
| function/method | `sandboxInfrastructureFailure` | 936–958 |
| function/method | `tryRecoverTransientSandboxFailure` | 960–1102 |
| function/method | `preserveSandboxAfterAgentFailure` | 1681–1697 |
| function/method | `tryRecoverAfterWorkspaceSyncFailure` | 1699–1732 |
| function/method | `handleDeletionGuardError` | 1749–1768 |
| function/method | `ownsArtifactCompletion` | 1770–1784 |
| function/method | `failInteractivePreservation` | 1786–1793 |
| function/method | `failBranchPreservation` | 1795–1802 |
| function/method | `assertInteractiveCompletionCurrent` | 1804–1833 |
| function/method | `parkOnWorktreeSyncFailure` | 1850–1864 |
| function/method | `promoteToAuto` | 2990–3133 |
| function/method | `completeSession` | 3135–3357 |
| function/method | `syncWorkspaceBranch` | 3359–3474 |
| function/method | `preserveWorkspace` | 3476–3478 |
| function/method | `quiesceSandboxAgent` | 3480–3509 |
| function/method | `suspendSandboxForRecovery` | 3511–3516 |
| function/method | `cleanupPodResourcesForRecovery` | 3518–3521 |
| function/method | `fixManually` | 3546–3635 |
| function/method | `deleteSession` | 3678–3770 |
| function/method | `getArtifactResumeObservation` | 4028–4050 |
| function/method | `forceComplete` | 4069–4117 |
| function/method | `kickPod` | 4119–4182 |
| function/method | `startStuckPodWatchdog` | 4184–4319 |
| function/method | `stopStuckPodWatchdog` | 4321–4330 |
| function/method | `recoverWorktree` | 4332–4445 |
| binding | `hostFetchRetryTimers` | 859–859 |
| binding | `infrastructureResumeRuns` | 1188–1188 |
| binding | `artifactResumeRuns` | 1189–1189 |
| binding | `artifactCompletionRuns` | 1190–1190 |
| binding | `coordinateInteractiveCompletion` | 1191–1192 |
| binding | `forceWithLeaseAllowances` | 1237–1237 |
| binding | `stuckPodWatchdog` | 1299–1299 |
| binding | `unsubscribeWakeRecovery` | 1301–1301 |
| binding | `resolveBranchSource` | 1315–1359 |

## Open questions

None about current source/scope/reference ownership. Next action after30 qualification
is the concrete31 plan for all27 named bodies/branch arrow/nine initializers, shared
coordinator/maps, immutable launch/legacy paths, three dynamic receiver contracts and
actual cleanup/preservation/recovery boundaries. Type-only manager result/creator
references must be accounted for without introducing a domain-to-manager runtime or
broad public dependency port. No new product/recovery policy is specified here.

## Qualification follow-up — 2026-10-19

30 subsequently passed qualification at the same product source above:253 affected
suites/5,152 passes/four inherited gates; full frozen uncached pipeline8,949 Vitest
passes/572 passing files/same ten gates plus35 Node script tests. All2,137 package/
script hashes and six root controls match. First expanded run's unchanged100ms runtime
assertion measured99ms; isolated/full affected/full pipeline rechecks pass on unchanged
source with retained first evidence. Plan/roadmap mark30complete. Four milestones
remain31–34. Next phase is the concrete31plan under standing continuation authority;
no31 product code was changed during30qualification. Full goal remains active.
