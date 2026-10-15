# R06a: fence stale artifact finalization by worker cycle

## Overview and authorization

Before extracting orchestration, reproduce and repair one source-derived race:
old artifact collection must not publish or clean up a new worker cycle created
by normal Pause then Message controls within the same pod generation/container.
The user authorized autonomous RPI, workers, review and branch-contained fixes.
All phases below are authorized together; no UI/schema/protocol change.

## Current state

See research/2026-10-15-artifact-finalization-boundary.md including its follow-up.
Artifact completion coalesces by pod/generation/cycle, but its ownership predicate
only compares generation/container/status/decision/guidance. Journal mark applies
to the latest cycle. A settled worker leaves no active-run pause barrier while
its artifact copy continues. A new message after pause can create another cycle.
This is source-derived until the first phase reproduces it.

The shared ownsArtifactCompletion helper also serves non-artifact paths. In the
queued-guidance path, settle can create a journal after capture; adding a cycle
comparison globally could break that behavior. Keep those semantics unchanged.

## Desired result

A captured artifact finalization owns only its captured generation and cycle,
plus the existing container/status/decision/guidance conditions. Once a new cycle
starts, success or failure from the old artifact copy cannot publish artifacts,
mark the newer journal, fail/complete the newer run, push an artifact branch or
clean up its container. The new run remains active and can later finish normally.
Existing no-journal interactive/legacy cases, duplicate completion, preserved
snapshot retry, native no-push and cancellation behavior remain compatible.

## Scope and approach

Own bounded artifact-specific edits in packages/daemon/src/pods/pod-manager.ts
and regression cases in its existing co-located test file. Existing collectors,
receipts and journals remain unchanged unless a discovered contradiction is
reported to root. No extraction, migration, new state, provider change or broad
completion-journal redesign in this task.

Use an artifact-specific ownership check that incorporates the existing helper
and compares the current journal cycle to the captured pod's cycle, treating
absence consistently as zero for existing no-journal cases. Apply it at entry
to preservation (before marking a journal), collector isCurrent, post-copy and
error paths, snapshot reuse and finalizer checks before publication/cleanup/final
transition. Preserve the existing allowed-removed-container option. Do not
retrofit cycle checks into unrelated shared-helper callers. No stale path should
mark or transition the new cycle merely to report that it was superseded.

A cycle mismatch must remain invalid even when generation and container match.
Pass the artifact-specific assertion through cleanupContainer's existing
assertReleaseAllowed callback, which rechecks after internal awaits. Catch the
recognized superseded outcome in the artifact finalizer and return without
letting it escape into broader failure handling; preserve unrelated errors.
This does not claim atomic cancellation of an already-issued external push or
container call; it fences work at the existing await/check boundaries.

## Phase 1: reproduce via production controls

Use existing createTestContext and real SQLite ledgers with deferred infrastructure.
Establish cycle N by consumeAgentEvents receiving normal completion and settling;
do not fabricate cycle N+1 by direct DB/repository mutation. Start handleCompletion
and hold the first actual artifact extraction call at a barrier. Call pauseSession,
then sendMessage with a resumed runtime stream held open. Wait for actual resumed
consumer/admission, assert same generation/container, cycle N+1 and active durable
run, then release the old copy. Assert the intended safe result and record the
baseline failure before changing production.

The test may use existing fixture setters for initial running resources, but
cycle advancement and pause/resume admission must traverse public manager methods.
If the traced sequence is blocked by production guards, stop with evidence and
revise the plan rather than forcing the race through direct mutations.

## Phase 2: repair and characterize ownership

Prove both old-copy success and old-copy rejection after the new cycle begins:
no artifact path/source-preserved marker/terminal event/cleanup is attributed to
the new run; its journal remains running, status running and durable run active.
Capture relevant side-effect counts before releasing the old copy so fixture
setup cannot mask an added call. Preserve container/source identity.

Also hold the existing beforeContainerCleanup hook after a valid old snapshot
was published; use public Pause/Message to start the new cycle, then release the
hook. Assert no subsequent container kill or journal/status mutation, and no
escaping stale error that fails the new run. The legitimately published historical
snapshot may remain; do not mislabel its pre-supersession publication as a defect.
The new run must later complete normally in this case too.

Use actual temporary artifact directories and collector staging cleanup where
the existing fixture supports them; release and await both copy and resumed
stream in finally, dispose DB/data and restore any test-local environment override.
No arbitrary sleeps for ordering; barrier deadlines must fail and cleanup owned
work. A resumed worker that subsequently completes must still be able to publish
its own artifact and complete exactly once. Assert the old run did not suppress
this valid follow-up. Preserve duplicate-completion coalescing.

Run the pre-existing artifact manager tests, collector/receipt/sandbox-adapter
tests, pending decision/completion journal tests, pause/message regressions,
and then the full daemon suite with SKIP_DB_TESTS=0.

## Phase 3: independent proof and integration

Use explicit Node22/pnpm9.15.4 and frozen install; fresh dependent package builds.
Run supported daemon build/typecheck, scoped Biome, secret scan and git diff --check.
Record exact commands, counts, pre-fix failure and final revision. Independent
review before PR reruns the new public-path regression and examines ownership
checks plus retained behavior. PR base codex/reliability; hosted checks must pass
before integration and targeted integrated verification. No main/deploy action.

No human manual check is required for this headless contract. Evidence is real
production manager/SQLite/filesystem with controlled runtime/container adapters,
not OS-process crash, real provider or actual Docker execution.

## Acceptance

- [ ] Public Pause/Message sequence advances cycle during old copy and reproduces bug.
- [ ] Old copy success and failure cannot mutate/clean up the new cycle.
- [ ] New worker can finish and publish its own artifact normally.
- [ ] Existing artifact/interactive/no-journal/retry/pause/decision regressions pass.
- [ ] Full daemon and supported validation checks pass.
- [ ] Independent pre-PR review, hosted and integrated proof recorded.

## Compatibility and rollback

No migration/API change or new work. The fix rejects stale finalization authority
while preserving current run resources. Reverting the bounded guard restores
previous behavior but also restores the race. No performance optimization claim.

## Status

Prepared by root and reviewed by research_cli. Review identified an internal
cleanup-await gap; root selected the existing cleanup assertion callback and
added a public-control pre-cleanup regression, rather than narrowing the safety
claim. No other blocking findings. Ready for worker implementation under the
standing campaign authorization.
