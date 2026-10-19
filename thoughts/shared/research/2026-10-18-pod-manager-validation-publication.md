# Slice 11 research: validation result publication

Date: 2026-10-18.
Baseline: 37d968d1f95beefba300b20df87eb98e695a4f75.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Existing ownership and boundaries

Ten slices are complete. pod-manager.ts is 17,399 lines. The evidence step is now
validation-evidence.ts. Immediately after that step, ordinary validation publishes
the completed attempt in pod-manager.ts:13612–13645 (34 lines including trailing
blank). Manual revalidation repeats the sequence at :14708–14740 (33 lines).

Each region performs, synchronously:
1. podRepo.update(podId, {lastValidationResult: result}).
2. Choose result.taskReview?.tokenUsage ?? result.reviewTokenUsage. If present,
   read the current stored pod, aggregate its review usage and write phaseTokenUsage.
3. validationRepo?.insert(podId, attempt, result), retaining its returned record.
4. eventBus.emit a pod.validation_completed event with a newly generated timestamp
   and the original result reference.

The ordinary and manual bodies are equivalent after ignoring comments/formatting
and renaming manual locals existingUsage→existing and prevReview→prev. No other
expression or ordering difference was found. Both regions finish before the caller
reloads s2 and checks terminal/killing status. These status reads/checks are outside
the candidate publication boundary; manual and ordinary return handling differ.

A separate pre-check sandbox-unavailability path at :13522 persists result/history
and emits an event before parking. It does not contain review-usage accounting.
It is a distinct path, not one of the two regions above. Advisory updates and council
adjudication also use separate writes and remain outside this boundary.

## Usage semantics

Nullish selection prioritizes taskReview.tokenUsage when present, including a
zero-valued usage object. The fallback covers metered reviewer work without a verdict.
When no selected usage exists, there is no usage getOrThrow/update inside the block.
The result write still precedes history and event publication.

With usage, the helper must fetch stored usage AFTER writing the result. Existing
non-review phase buckets are spread into the new map. The review bucket is rebuilt
from input/output sums and cachedInputTokens/costUsd sums only when those sums are
strictly positive. Missing cache/cost means zero. Zero/negative totals are omitted;
this is existing arithmetic/shape behavior, not a new validation rule. Do not switch
to the shared addTokenUsage helper or preserve additional review keys by accident.

Other cost accounting exists for agent runs and advisory QA (:6056–6077 etc.). The
publication sequence only accounts the current result's selected review usage.
Later independent-council usage/rewrites are handled by existing manager logic.
This boundary is not a new deduplication or billing policy.

## Persistence and events

pods/validation-repository.ts exports StoredValidation and ValidationRepository.
insert runs its OWN SQLite transaction, assigning monotonically increasing pod-local
sequence and cycle when attempt resets. It returns a record decoded from persisted
JSON. That transaction does not include earlier pod result/usage writes or the event.
getLatest/getForSession/updateResult/updateAdvisoryResult support subsequent readers.

pods/event-bus.ts emits synchronously: persist raw event through eventRepo.insert,
optionally sanitize for subscribers, tag the event with its persisted ID, then invoke
global and pod subscribers. Subscriber exceptions are caught/logged by the bus;
event repository or processing errors can propagate. The publication block adds
no catch or transaction. EventRepository stores JSON independently in events.

Consequences of current ordering: usage-write failure can leave lastValidationResult
saved; history failure can leave result/usage saved; event persistence failure can
leave all three prior effects saved. A normal subscriber can synchronously inspect
them and change pod status before the caller reloads s2. Subscriber mutation of the
original result does not retroactively alter earlier persisted JSON snapshots.
No asynchronous yield occurs anywhere in these two regions.

The three collaborator references (podRepo, optional validationRepo, eventBus) are
captured by manager destructuring at construction. Their method lookups occur at
call time. Missing validationRepo skips only history, not usage or event emission.

## Returned history identity and adjacent behavior

Ordinary council adjudication updates exactly validationRecord.id (:13867–13868),
then advisory publication uses the same optional ID (:14227–14230). Manual advisory
publication also uses the optional ID (:14906, :14912). Replacing or losing the
returned record could update the wrong attempt or create an extra row.

Existing public tests at pod-manager.test.ts:23988–24072 cover review cost accounting,
agent-bucket retention and metered-review fallback. Advisory cases around :15200–15640
cover exact history updates, late evidence preservation and single completion events.
The recurring-finding auto-hoist cases around :17829 cover adjudicated history.
Slice 10's evidence compatibility cases observe stored result/history before event
callbacks and current persistence before a terminal-status check.

Verified adjacent suites are pods/validation-repository.test.ts (already in the
52-suite affected set), pods/event-bus.test.ts, pods/event-repository.test.ts, and
pods/token-telemetry-repair.test.ts. The last three and a future direct publication
suite extend that set to 56 distinct suites. No test was run in this planning turn.

## Next action

Prepare the concrete shared synchronous publication extraction plan and illustrated
HTML for explicit approval. Planning leaves product code unchanged. The established
characterize → extract → qualify structure and incremental commit/push authorization
continue to apply.
