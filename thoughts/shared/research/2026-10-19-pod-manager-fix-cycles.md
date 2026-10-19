---
date: 2026-10-19T01:20:10+02:00
researcher: Codex
git_commit: 4e7bfaa36679fe8a8c3cb4c87f13e2a3f0920a81
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice 28: fix-cycle task, admission/recycling, delivery, feedback and operator commands"
tags: [research, codebase, pod-manager, fix-cycles]
status: complete
last_updated: 2026-10-19
last_updated_by: Codex
---

# Slice 28 research: complete fix-cycle boundary

## Question and baseline

Locate the roadmap's complete fix-cycle responsibility after delivery ownership in
27, including actual live/captured references and its startup relationship with the
new polling owner. References below use packages/daemon/src/pods/pod-manager.ts at
4e7bfaa36679fe8a8c3cb4c87f13e2a3f0920a81. Manager is 6,916 lines and the
public object still has 73 members. Frozen27 qualification is running when this
research is recorded; this report makes no claim that its full pipeline is done.
No28 product change is made. Full bodies and binding/reference inventories are saved
under .autopod-data/fix-cycles/.

## Task and feedback text

buildPrFixTask (:307–399) follows linkedPodId to the originating task, retains the
root attempt/iteration/PR description, and uses seriesDescription for a single-PR
series. CI annotation paths/messages and review ids/paths/bodies pass through the
profile's content-processing policy, falling back to enabled quarantine/standard
sanitization. Human userMessage is trimmed and appended. Task text says to assess
review feedback, push the existing branch, avoid container PR/comment APIs and report
reviewFeedbackResponses; only fixed can authorize conversation resolution.

buildActionableFailureSummary (:409–449) formats the same externally supplied
CI/review data with that sanitizer before polling enqueues it. Both functions are
currently exported from the manager and have existing public/test consumers. The
1,000-line delivery owner limit did not change these algorithms. The new polling
owner receives the summary function as a narrow captured callback.

formatReviewFeedbackReply (:453–462) maps four reported outcomes, trims response
text to REVIEW_FEEDBACK_REPLY_MAX_CHARS=2000 (:451), and adds the original prefix.
postFixPodReviewFeedbackReplies (:2334–2386) skips missing PR/responses/provider
support, trims/filters responses, posts through the profile-selected host PR manager,
and emits original counts/errors. Posting/resolution failures are best effort and do
not prevent completion. Source records the existing system behavior; no live replies
are sent during this rewrite.

## Predicates and delivery parking

isFixCycleTerminal (:1997–1998) includes failed in addition to the shared terminal
helper. isFixPodRecyclable (:2007–2008) additionally includes merge_pending.
FIX_DELIVERY_FAILED_PREFIX (:2010) is the shared original text used by parking and
admission suppression. isParkedHostPushRecovery (:2052–2058) accepts awaiting_input
with that prefix or a request_credential escalation whose payload.source is host_push.
isRetryableFixDeliveryFailure (:2060–2067) requires awaiting_input/failed, linked
parent, last validation pass and that same prefix.

parkFixPodDeliveryFailure (:2035–2050) sends GitCredentialError to the delivery
credential parking owner from27. Other errors log/emit the original operator-retry
text and transition awaiting_input with the prefix; no new AI retry is started.
All these bodies have no this reads and no live manager dependency reads.

providerBindingForFixPod (:2012–2033) is different: it reads deps.providerAttemptRepo
at call time. It reconciles a missing provider id only when the latest attempt agrees
with the source runtime/model and any existing account snapshot. Otherwise it returns
the original account/provider fields. These reads are live, not a construction-time
copy of the repository field.

## Canonical spawn and recycling lifetime

maybeSpawnFixSession is a 249-line async arrow binding (:2084–2332), separate from
the12 function/method declarations in the inventory. It re-reads parent and canonical
fix rows. Linked fix pods and terminal parents return immediately. A fix awaiting
operator recovery with the delivery-failed prefix suppresses automatic retries;
other active states leave feedback queued. Terminal/merge_pending rows can recycle.
Exhausted max attempts fails the parent, stops its merge poller and returns.

The current profile and resolveBranchSource select delivery ownership. The latter
currently lives immediately before the fix helpers, routes single-PR series to its
PR-owning pod, and remains assigned31 by the roadmap; it is a narrow cross-domain
callback, not another algorithm to move silently into28.

Recycling a merge_pending fix stops its poller and awaits cleanup before its queued
transition. The original update clears runtime/validation/escalation/task-summary
fields, increments fixIteration, carries provider binding and PR-owner branch/base/
PR URL, then increments parent attempts, enqueues and reports. New row creation uses
a placeholder task; the actual drained feedback task is constructed later by the
already-extracted agent/provisioning workflow. Up to10 generated-id collisions can
retry insert. New fixes preserve root linkage/provider/target/options and PR owner.

A frozen parent reads deps.launchConfiguration/admitDerived at call time and admits
an immutable derived kind=fix config with resolved branch/base/linkage and no series
dependents; unavailable admission throws CONFIG_EXECUTION_UNAVAILABLE. Legacy parents
insert directly. After insert, enqueue and pod.created precede parent fixId/attempt
update and activity. Existing statement/order/identity behavior remains the baseline.

## Validated fix delivery

completeFixPodAfterPush (:2400–2509) checks collected guidance first and resolves the
original base/branch/worktree. It checks linked-parent terminal state before queuing,
inside the shared merge queue and after rebase. The same queue constructed by27 is
used by approval, polling and this fix delivery. Rebase conflict reports the conflict
but still reaches original fix completion without a push. Successful rebase pushes
with force=true and explicit freshly resolved credentials. A delivery exception parks
the fix and returns; host review replies occur only after branchPushed.

The remaining path emits parent-poller ownership, awaits cleanup, transitions
approved→merging→complete and persists/emits pod.completed. It never calls mergePr;
parent polling owns that effect. The raw pushBranch call remains the original path;
this compatibility work does not add publication/journal semantics to it.

## Three public controls and distinct admission

extendPrAttempts (:6154–6200) admits failed pods with the exhausted-attempt reason,
adds to the configured/default ceiling up to20, clears fixPodId unless reuseFixPod,
updates the ceiling, transitions merge_pending and restarts polling.

spawnFixSession (:6375–6430) requires merge_pending, a root pod and a PR URL or single
series membership. It conditionally bumps the cap (up to20), enqueues trimmed supplied
or default feedback and calls the canonical helper with an empty synthetic status.

requestFixSession (:6432–6473) rejects linked fix pods and returns structured
parent_terminal for terminal roots. Other current states enqueue the supplied message
and invoke the canonical helper. It rechecks terminal outcome and returns actual
queue length/fix id. It does not duplicate spawnFixSession's merge_pending/PR checks.
These three methods and the canonical callback have no this reads. Keep their current
different admissions, callback arities, synchronous effects and async return shapes.

## Construction and connections

Fix predicates/provider/parking helpers follow the existing resolveBranchSource
binding. The new27 scan/credentials/PR factories are already available before this
section, as are original provider factory, merge queue, events/readiness and cleanup
function declarations. maybeSpawnFixSession initializes before createDeliveryPolling
(:2520 onward), which captures it; resumeMergePolling runs before later runtime/
workspace factories. Delivery polling provides start/stop as const outputs rather
than the old hoisted functions. The canonical spawn arrow calls stopMergePolling
only when invoked; its current closure creation does not read that later binding.
A future extraction's actual capture construction must account for that timing.

Existing public commands capture startMergePolling later, before the public object.
Completion/continuation/validation owners receive fix helpers as narrow callbacks;
provisioning receives buildPrFixTask; polling receives the summary and canonical
spawn callback. Same mutable queue/provider/feedback repositories are shared.
Only two live fields appear: providerAttemptRepo in binding selection and
launchConfiguration in canonical spawn. None of the12 declarations/five bindings
has a dynamic this receiver use. No state/schema/profile change is part of this scope.

## Existing coverage and artifacts

The unchanged1,192-case public suite exercises PR fix spawning/recycling/caps,
provider binding, linked-parent ownership and feedback. Current file-local tests
include pr-fix-task.test.ts, fix-feedback-repository.test.ts, feedback-formatter.test.ts
and configuration launch-admission/launch-resolver/series-launches tests.27 adds local
source-bound polling/feedback deduplication and validation fix-routing tests. Local
ledgers/private SQLite/files with controlled transport do not establish live
GitHub/ADO/container/model execution. Relevant inherited regression set is216 suites.

Related: ../plans/2026-10-18-pod-manager-remaining-roadmap.md;
../plans/2026-10-19-pod-manager-delivery-merge.md;
2026-10-19-pod-manager-delivery-merge.md.

## Exact declaration inventory

| Kind | Symbol | Current lines |
|---|---|---|
| function/method | `buildPrFixTask` | 307–399 |
| function/method | `buildActionableFailureSummary` | 409–449 |
| function/method | `formatReviewFeedbackReply` | 453–462 |
| function/method | `providerBindingForFixPod` | 2012–2033 |
| function/method | `parkFixPodDeliveryFailure` | 2035–2050 |
| function/method | `isParkedHostPushRecovery` | 2052–2058 |
| function/method | `isRetryableFixDeliveryFailure` | 2060–2067 |
| function/method | `postFixPodReviewFeedbackReplies` | 2334–2386 |
| function/method | `completeFixPodAfterPush` | 2400–2509 |
| function/method | `extendPrAttempts` | 6154–6200 |
| function/method | `spawnFixSession` | 6375–6430 |
| function/method | `requestFixSession` | 6432–6473 |
| binding | `REVIEW_FEEDBACK_REPLY_MAX_CHARS` | 451–451 |
| binding | `isFixCycleTerminal` | 1997–1998 |
| binding | `isFixPodRecyclable` | 2007–2008 |
| binding | `FIX_DELIVERY_FAILED_PREFIX` | 2010–2010 |
| binding | `maybeSpawnFixSession` | 2084–2332 |

## Open questions

None about the current boundary. Next action after27 qualification: create the
complete28 plan covering all12 declarations, the canonical arrow and four other
bindings, public helper exports, live-field reads and the polling startup dependency.
Do not replace complete fix-cycle ownership with helper-only relocation.29–34 remain
controls/resources/workspace/admission/consolidation/final qualification; all final
facade,327-unit/73-public-member and mutable-owner/cleanup gates remain required.

## Qualification follow-up — 2026-10-19

Slice27 qualification subsequently passed against the same product baseline above:
216 affected suites/4,955 passes/four inherited gates; full frozen uncached pipeline
8,835 Vitest passes/547 passing files/same ten gated cases plus35 Node script tests.
All2,081 package/script hashes and six root controls still match. Its plan/roadmap
now mark27 complete; goal continues through34. Next phase is the concrete28 plan,
not another27 helper extraction. This follow-up changes no source finding or product.
