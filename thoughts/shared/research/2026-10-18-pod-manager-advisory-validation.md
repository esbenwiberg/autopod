# Remaining pod-manager structure and advisory validation

Date: 2026-10-18. Status: RESEARCH COMPLETE; planning only.
Baseline: ecc324ca4a403d49397dd63cecb1a881e653ad06.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Request and current evidence

The user requested a finite remaining roadmap and then starting Slice 19. Slices
1–18 have completed plans; Slice 18's final qualification records 8,467 passing
Vitest tests, 35 script checks and ten existing gated skips. These are inherited
results, not new runs. The isolated checkout was clean at this baseline.

pod-manager.ts is 16,521 lines. Parsed TypeScript exposes 73 public object members
and 327 non-import top-level declarations, manager-closure declarations/statements
and public members. The original illustrated plan grouped workstreams without a
fixed remaining count. The current manager still includes a 2,861-line processPod,
645-line consumeAgentEvents, 794-line approveSession and validation entry points
of 1,103 and 555 lines. Their nested code is included in their containing AST unit;
this inventory does not imply each nested behavior was independently audited today.

## Advisory call path

pod-manager.ts:5363–5391 defines advisoryPublicationOwnership (29 lines).
:5393–5529 defines runAdvisoryAfterValidation (137 lines). There are two external
awaited runner calls at :13376/:14024 and two following ownership checks at
:13383/:14031, in triggerValidation/revalidateSession. Both create/carry a PR and
transition validated before advisory completion; both retain post-await lifecycle
checks before stopping containers or continuing completion.

advisoryRuns is constructed at :3807. resolveApprovalReadiness reads it at :3181;
cleanupContainerAfterAdvisorySettles reads it at :3840. The single-slot semaphore
and queue (:3812–3831) are shared across pods in one manager. Deferred cleanup waits
for that registry promise and checks guidance first. Existing validation-progress
composition is :5018–5020, before the advisory functions' definition site.

The ownership helper uses captureValidationOwnership from validation-ownership.ts:
validated status, lifecycle/execution/config identity, current invocation and pending
decision checks. It additionally checks attempt and optional latest history id. The
pending-decision adapter reads nudgeRepo.hasPending and optional repository unanswered
support with nullish fallback to the pod escalation. The runner registers an inner
promise and deletes it only if still current. Its initially false registered flag
avoids an early read of the run binding before initialization.

The engine method is optional. If missing the runner returns the exact blocking
result early. Otherwise it checks ownership, emits waiting progress, acquires a
slot and rechecks before engine launch. Release lives in the inner finally after
acquisition. The engine sees exact config/result references, undefined signal and
owned callbacks. The advisory callback writes history and, if current, live result
and readiness before forwarding completion events. Final return may repeat those
writes. Current engine failures warn and return blocking evidence; stale failures
retain stale-execution propagation.

Final known usage and exact historical evidence can persist before the final
ownership check even when a replacement lifecycle exists for the same immutable
pod/task. Current-state publication remains fenced. The history repository's
updateAdvisoryResult merges one JSON field into exact pod/id row bytes and preserves
other evidence. Its result is not used to alter ownership policy. Original read
and write timing matters; this is not one atomic publication transaction.

## Existing evidence and types

- interfaces/validation-engine.ts defines optional runAdvisoryBrowserQa with nullable
  AdvisoryBrowserQaResult, optional progress/signal/phase callbacks.
- pods/validation-progress.ts exports createValidationProgress; its owned callbacks
  suppress stale phase/review events while retaining subscriber event shape.
- pods/validation-ownership.ts exports captureValidationOwnership and
  ValidationSupersededError. No standalone ownership test file is assumed.
- pods/validation-repository.ts exposes updateAdvisoryResult and isLatestForPod.
- pods/nudge-repository.ts exposes hasPending; direct local integration can use the
  real repository without adding a fake standalone suite path.
- pods/readiness-review.ts exports the real readiness service. Its tests include
  advisory concerns, in-flight/waived readiness and row/history fallback.
- pod-manager.test.ts:15134 onward already covers late advisory history/usage without
  replacement publication or resource release, queued stale work, deferred advisory,
  approval waiting (:15422), newer results (:15498) and revalidation PR timing (:15566).
- pod-manager.test.ts:29314 tests callback merging before subscriber observation for
  both public validation entries. Existing recurring-finding cases also use advisory.
- validation/advisory-browser-qa-runner.test.ts and pods/readiness-review.test.ts exist
  and are not in Slice 18's 92-suite affected list. validation-repository/progress/
  engine/operator guidance/lifecycle suites are already included.

## Handoff and limits

No product/test source was changed, and no implementation checks ran during planning.
The roadmap assigns baseline declarations to proposed delivery milestones; those
assignments are design decisions in the plan, not descriptions of existing modules.
Slice 19's complete plan chooses a narrow internal factory with twelve captured
collaborators and leaves semaphore/registry placement, callers, approval and cleanup
where they are. All further design and verification criteria are in that plan.
Next action is review/explicit approval of the concrete Slice 19 plan.
