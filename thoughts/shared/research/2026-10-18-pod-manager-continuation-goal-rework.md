---
date: 2026-10-18T23:15:40+02:00
researcher: Codex
git_commit: 0b7f6cc2b31987870575f12aee5fbba08a3d7428
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice 22: continuation and native Goal rework"
tags: [research, codebase, pod-manager, continuation, native-goal]
status: complete
last_updated: 2026-10-18
last_updated_by: Codex
---

# Slice 22 research: continuation and native Goal rework

## Research question and baseline

Locate the continuation, manual recovery and native Goal rework responsibilities
assigned to milestone 22 of the user-authorized remaining sequence. Current manager
source has 13,833 lines following Slice 21. Its full unchanged public suite passes
1,192 cases; the 99 affected suites pass 3,450. Slice 21 full uncached qualification
passes 8,621 Vitest cases plus 35 script checks with ten existing gated skips. No Slice 22 product/test
change has started. The complete goal still extends through Slice 34.

## Declaration inventory

All references below are to packages/daemon/src/pods/pod-manager.ts at 0b7f6cc2b31987870575f12aee5fbba08a3d7428.
There are eighteen function bodies and the REWORK_IN_PROGRESS_PREFIX constant (:313)
in this milestone's current baseline, corresponding to the roadmap inventory.

| Function | Current lines | Existing role |
|---|---|---|
| sanitizeSecurityReworkValue | 315–325 | Bounds/sanitizes structured scanner metadata |
| buildManualReworkReason | 327–378 | Selects validation, security-scan or status fallback rework text |
| renderPiHandoffFile | 548–559 | Renders the managed Git-excluded Pi handoff banner |
| appendDecisionContext | 1875–1883 | Appends completion-journal recovery and queued guidance |
| buildRecoveryTask | 1885–1887 | Wraps recovery-context task with decision context |
| buildContinuationPrompt | 1889–1891 | Wraps continuation-context prompt with decision context |
| buildReworkTask | 1893–1895 | Wraps rework-context task with decision context |
| visibleProviderHandoffActivity | 2090–2106 | Projects recent visible status/tool events |
| prepareProviderContinuationHandoff | 2108–2122 | Protects the handoff path before writing continuity material |
| queueProviderContinuation | 2124–2184 | Opens target segment, updates/queues pod and restores fields on failure |
| handleProviderLimit | 2186–2251 | Drains runtime, syncs/kills container and selects/queues failover |
| recordContinuationProvenance | 2292–2302 | Runs current-binding/lifecycle preflight and records evidence |
| beginGoalTaskRework | 2304–2328 | Requires achieved/stopped Goal then records separate Task rework |
| taskFeedbackEvents | 2330–2355 | Primes runtime and returns resumed or fresh Task event stream |
| resumeNativeGoal | 5833–5884 | Checks native Goal revision/state/budget then atomically queues resume |
| assertCanRework | 11602–11629 | Checks native Goal/worker-retry admission |
| resumePod | 12856–13132 | Chooses artifact/fix/infrastructure/PR/validation recovery |
| continueProvider | 13134–13373 | Validates operator continuation/recovery and drains/prepares/queues it |

## Recovery and feedback flow

Manual reason construction (:327–378) prefers failed validation feedback, otherwise
uses a blocked push scan's structured sanitized metadata, otherwise selects a status
fallback. It does not include matched scanner content. Pi handoff rendering
(:548–559) retains raw persisted instructions after its managed-file banner.

The three recovery-context wrappers (:1885–1895) await existing recovery-context.ts
functions, then append completion-journal recovery text and uncollected human
guidance via appendDecisionContext (:1875–1883). Existing worktree helpers collect
bounded Git log/diff context. recovery-context.ts also sanitizes/bounds failover
handoff sections and writes through a private temporary file, sync and rename.

recordContinuationProvenance (:2292–2302) calls continuation-preflight.ts with a current
pod reader, pending-decision check, bound-profile resolver and provenance ledger.
That helper compares lifecycle/container/runtime/model/account/worktree/branch/contract
before and after awaited execution probes; it preserves unanswered human decisions
and reports blocked diagnostics before configuring another turn.

taskFeedbackEvents (:2330–2355) obtains the resume environment, runtime, provenance
and the exact MCP array returned by primeRuntimeForResume. Ordinary feedback returns
runtime.resume; fresh Task feedback calls runtime.spawn using current task/model/
reasoning, system instructions, execution target and that same MCP array. An achieved,
stopped native Goal may begin separately recorded Task rework through
beginGoalTaskRework (:2304–2328); its apply callback updates task/snapshot/session ids.
The original Goal achievement is retained by the delegated launch service.

## Provider-limit and explicit continuation flow

visibleProviderHandoffActivity (:2090–2106) reads the live optional event repository's
last 80 activity events, retaining status text and tool/outcome text. Handoff preparation
(:2108–2122) requires a safe worktree and exclusion support, awaits the exclusion, then
writes handoff material using those selected visible events.

queueProviderContinuation (:2124–2184) inspects the latest closed source segment to
decide whether native session ids can remain. It resolves the selected target profile,
opens the target provider attempt and updates the pod binding/container/recovery fields
before transitioning queued. On update/transition failure it closes the replacement
aborted and restores original fields, then rethrows. Enqueue can defer until the current
run exits via the live optional requeue callback. The queued activity follows enqueue.

handleProviderLimit (:2186–2251) awaits runtime abort, optional workspace sync, preview/
deny receiver stop and bounded container kill. Each unsafe drain/sync/kill case logs
and returns without advancing continuation. Cleanup always clears its local timeout;
success forgets MAX lineage and clears the pod container before failover selection.
No eligible target emits a typed diagnostic. Automatic queue failure logs and emits
an unsafe-continuation status.

continueProvider (:13134–13373) rejects active task workers, unsupported states,
unsafe/missing worktrees and missing definitive quota evidence. Profile-primary
recovery is limited to failed pods. Same-provider continuation has its own one-retry
ceiling; alternate providers require configured unused targets within maxHops. Worker
retry authorization records operator identity and selected binding. Existing source
execution drains/syncs/stops/kills with a timeout before handoff preparation and target
queueing; stranded active attempts close aborted. The returned action distinguishes
same-provider, alternate-provider and primary-provider recovery.

## Native Goal and recovery controls

resumeNativeGoal (:5833–5884) first verifies execution termination, then requires an
immutable Goal launch, Goal service, paused/failed state, safe retained worktree, no
pending escalation and no active run. After awaited capability checking, an atomic
pod change rechecks lifecycle/status and durable task budget, prepares the requested
Goal revision, increments generation, queues recovery and schedules enqueue after
commit when available. Errors retain their existing codes and timing.

assertCanRework (:11602–11629) first verifies termination. A native Goal must already
be achieved/stopped. Interactive mode returns; otherwise recorded worker retry failure
requires the same bound-profile/binding/backoff admission check as current execution.

resumePod (:12856–13132) guards native Goal and termination/guidance first. Artifact
collection recovery coalesces on the shared artifactResumeRuns map, verifies preserved
snapshots and lifecycle ownership, invokes completion and checks preservation/final
status. Retryable fix delivery uses the retained validated source. Infrastructure
validation resume coalesces separately and detaches a caught/finally-cleaned revalidation
promise. Safe pre-agent sandbox recovery checks startup admission, kills the old sandbox,
rechecks generation/container, clears session ids and queues the original agent or
validation-only work. Passing validation without a PR retries push/PR, transitions
validated and can schedule auto-approval. Other supported cases revalidate with force.

## Dependencies, initialization and state

These functions capture original pod/nudge/profile/account/runtime/worktree/container/
logger/queue references. Original deps lookups stay live for eventRepo,
providerAttemptRepo, requeueSessionAfterCurrent, launchConfiguration and both worker/
sandbox infrastructure backoff settings. No public-manager bag is currently passed
into these original bodies; they close over their manager scope.

Only resumePod uses public this calls: handleCompletion, revalidateSession and
approveSession. The original callback awaits, catches, finally handlers and detached
setImmediate/Promise.then behavior are part of current flow.

Mutable infrastructureResumeRuns/artifactResumeRuns are constructed at :3109–3110;
artifact collection observation also reads the latter at :12848. Their roadmap owner
is milestone 31. Active-run state is constructed at :3115 and belongs to milestone24.
The current functions use these same collection objects, not copied projections.

Several original function declarations are hoisted but their collaborators initialize
later: provider-attempt context is composed after activeAgentRunResolvers at :3142;
getResumeEnv comes from worker credentials at :4231; syncWorkspaceBack comes from
workspace transfer at :4264. primeRuntimeForResume is composed at :2357. Validation
trigger composition (:5193+) captures beginGoalTaskRework/taskFeedbackEvents. Completion
decision composition (:4307+) reads the REWORK_IN_PROGRESS_PREFIX constant. Merge-poller
startup precedes worker credential composition but does not invoke these continuation
functions during construction. These are actual capture/consumer relationships in the
baseline, distinct from invocation after manager construction.

## Existing evidence and related code

- pod-manager.test.ts :5552–6531 covers automatic drain/protection/requeue, ambiguous
  errors, exhausted/ineligible policies, auth/outage, unproven teardown and rejected
  operator continuation without mutation.
- pod-manager.test.ts :1255 and :1887 covers exhausted sandbox startup admission and
  safe original-task Resume. Artifact collection coalescing/restart appears :1089+.
- pod-manager.test.ts :25923 covers native Goal admission before human work;
  :31238–31325 covers achieved Goal Task feedback and identical primed/spawned MCP.
- runtime-resume-context.ts and its direct tests cover immutable capability/credential/
  MCP priming; continuation-preflight.ts covers ownership around execution probes.
- recovery-context.test.ts and feedback-formatter.test.ts cover bounded recovery/
  handoff and feedback formatting. goal-repository.test.ts/pod-goal-service.test.ts
  cover durable native Goal state/process/budget behavior independently.
- Related current research: 2026-10-18-pod-manager-provider-attempts-binding.md.
- Remaining roadmap: 2026-10-18-pod-manager-remaining-roadmap.md.

## Open questions and next phase

None for current-state research. Next is the concrete milestone-22 plan under the
already authorized remaining sequence. This report makes no implementation or
policy change; Slice 22 product/test bytes remain untouched.
