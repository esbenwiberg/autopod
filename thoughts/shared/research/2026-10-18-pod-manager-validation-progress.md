# Slice 13 research: validation progress event callbacks

Date: 2026-10-18 (Europe/Copenhagen).
Researcher: Codex.
Baseline: 338c2476c76369a89130e7b3e044f1280b757efa.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Current boundary

Twelve slices are complete. pod-manager.ts is 17,244 lines. Its validation helpers
already separate attempt start, inputs, execution, evidence, publication and
infrastructure classification/parking. Two remaining local functions implement
validation progress-event formatting and callback forwarding.

pod-manager.ts:5846–5911 contains buildPhaseEventCallbacks(podId), 66 lines including
the trailing blank. The preceding four-line comment describes desktop validation
chips. :6727–6743 contains ownedValidationCallbacks(ownership, callbacks), 17 lines
including the trailing blank. Neither constructor performs I/O or checks ownership.
Both return fresh callback objects/functions synchronously.

## Event behavior

buildPhaseEventCallbacks returns three callbacks:
- onPhaseStarted emits pod.validation_phase_started with podId, phase and a fresh
  new Date().toISOString() timestamp.
- onPhaseCompleted creates a fresh timestamp and forwards the supplied phaseStatus
  plus phaseResult under one of ten keys: setupResult, buildResult, testResult,
  lintResult, sastResult, healthResult, pageResults, factResult, reviewResult,
  advisoryResult. The casts do not validate/clone the value or derive phaseStatus.
  Nullable fact/review/advisory values retain their current behavior. An unknown
  runtime completion phase matches no branch and emits nothing; start does not
  perform a similar runtime phase check.
- onReviewProgress emits pod.review_progress using progress.updatedAt as timestamp,
  forwarding the same progress object. It does not substitute the daemon clock.

The functions call the existing eventBus directly. event-bus.ts persists first,
then optionally sanitizes, tags the live envelope with _eventId and notifies
subscribers. EventRepository inserts JSON into events; it does not use the event's
timestamp as the SQL created_at. Subscriber exceptions are handled by the bus;
repository/serialization/emission errors can propagate through these callbacks.
The callback helpers themselves add no catch, async boundary or transaction.

Shared event shapes and the ten-phase union are in shared/src/types/events.ts:27–37
and :199–237. The callback interface in interfaces/validation-engine.ts has three
optional void-returning members. Manager imports nine result/progress types used
only by buildPhaseEventCallbacks: BuildResult, FactValidationResult, HealthResult,
LintResult, PageResult, ReviewProgressSnapshot, SastResult, SetupResult, TaskReviewResult.
ValidationPhase and ValidationResult have other manager uses.

## Ownership and callers

ownedValidationCallbacks returns all three wrapper functions even when callbacks
is undefined. Each invocation calls ownership.isCurrent() before optional member
lookup and forwards the original arguments synchronously only when current.
It preserves callback method receiver and late lookup of methods on both captured
objects; return values are discarded. It does not call assertCurrent or catch errors.

captureValidationOwnership remains a separate existing implementation. Its default
status is validating and it compares captured lifecycle/source/provider identity,
invocation ownership and pending decisions. Its isCurrent converts the existing
ValidationSupersededError into false. Manager claimValidation owns controller maps;
advisoryPublicationOwnership supplies validated status/latest-attempt/run rules.

Four buildPhaseEventCallbacks calls exist: advisory :5993, ordinary validation
:13498, independent council :13662, manual revalidation :14572. Two direct manager
ownedValidationCallbacks calls exist: advisory :6002 and independent council :13662.
The same ownedValidationCallbacks name is injected at :5517 into
createValidationExecution; that module calls it when invoking the blocking engine.

Advisory completion deliberately overrides the spread wrapped completion callback:
it calls mergeAdvisoryResult first, then checks ownership before forwarding to the
raw phase-completion callback. This can retain historical advisory evidence even
when current progress publication is suppressed. That merge/order remains manager
policy, separate from the wrapper used for advisory start/review-progress callbacks.

## Existing tests and qualification

Manager tests :14724 cover typed live review progress, :16960 cover setup events,
:15130+ and :15498+ cover superseded/deferred advisory behavior and :24154+ cover
validation admission lifecycle ownership including suppressed stale phase events.
The validation execution compatibility group at :27811+ covers callback wiring.
Local-validation-engine tests cover phase setup ordering, skipped phases, facts,
review, council and advisory behavior. WebSocket tests cover subscription/replay;
websocket.ts forwards serialized events from the same bus/repository.

The predecessor's explicit affected set contains 60 daemon suites. Verified existing
local-validation-engine.test.ts and api/websocket.test.ts are distinct additions.
A future pods/validation-progress.test.ts would bring that set to 63. No standalone
validation-ownership.test.ts exists here; manager ownership tests cover that boundary.
progress-event-repository.ts stores agent-reported session progress in a different
table and is not the repository used for these validation events.

No product/test edits or implementation test runs occurred during this planning
turn. The working tree was clean at the verified baseline. Earlier HTML proposals
remain historical approval snapshots. The next artifact is the implementation plan.
