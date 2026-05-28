---
title: "Retry review infrastructure timeouts"
touches:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/feedback-formatter.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/pods/feedback-formatter.test.ts
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.test.ts
does_not_touch:
  - packages/shared/src/types/
  - packages/escalation-mcp/
  - packages/desktop/
  - packages/daemon/src/pods/state-machine.ts
  - packages/daemon/src/db/migrations/
---

## Task

Add daemon-owned resilience for AI task review infrastructure failures during validation. When the deterministic validation gates pass but the daemon review runner times out or fails with a retryable infrastructure error, retry validation review with bounded backoff instead of sending correction feedback back to the agent.

If the review infrastructure keeps failing after the retry budget is exhausted, move the pod to `review_required` with clear status/activity wording. Do not park these pods in `awaiting_input` or tell the agent to call `report_blocker`.

## Why

Pods sometimes end up showing "Agent needs input" after all tests and required facts pass because the reviewer process timed out. That is an infrastructure failure, not work the coding agent can fix, so agent rework and `report_blocker` loops create noise instead of progress.

The daemon already treats AI review as a blocking validation gate; this keeps that safety property while making transient reviewer failures resilient.

## Touches

Modify the daemon validation orchestration in `packages/daemon/src/pods/pod-manager.ts` so retryable review-infrastructure failures are handled before the normal correction-feedback path. Update `packages/daemon/src/pods/feedback-formatter.ts` so review execution failures no longer instruct the agent to call `report_blocker`.

Add or update targeted tests in `packages/daemon/src/pods/pod-manager.test.ts`, `packages/daemon/src/pods/feedback-formatter.test.ts`, and, if a classifier helper lands in the validation layer, `packages/daemon/src/validation/local-validation-engine.test.ts`.

## Does not touch

Do not change shared validation or pod types under `packages/shared/src/types/`. Do not change MCP tools, desktop UI, pod status values, the state machine, profile fields, or database migrations.

Do not change the agent-facing `pre_submit_review` MCP tool or advisory browser QA retry behavior in this brief.

## Constraints

`local-validation-engine.ts` currently marks missing review output from timeout/infra failure as a failed review phase using `reviewSkipKind === 'review-timeout' | 'review-failed'`. Keep that safety behavior: review infrastructure failures must not become a validation pass.

`pod-manager.ts` currently sends failed validation results through the normal correction path. The fix must intercept review-infra-only failures before `buildCorrectionMessage()` and `runtime.resume()` so the agent is not asked to fix something outside the diff.

Use a daemon-local retry policy for v1: 3 retries with 10s, 30s, and 90s backoff. Respect pod kill/abort state during waits, and avoid consuming the normal `maxValidationAttempts` budget for these infra retries.

## Skills to reference

None. This task does not touch `Profile`, `PodStatus`, or `state-machine.ts`, so `/add-profile-field` and `/add-pod-state` do not apply.

## Test expectations

Update `pod-manager.test.ts` with a case where validation returns a review timeout, then succeeds on a retry. Assert the daemon retries validation without calling `runtime.resume()`, and the pod reaches the normal validated path.

Update `pod-manager.test.ts` with a case where review infrastructure failures exhaust the 3 retry budget. Assert the pod transitions to `review_required`, does not enter `awaiting_input`, does not set a `report_blocker` pending escalation, and does not resume the agent.

Update `pod-manager.test.ts` or `local-validation-engine.test.ts` to prove only review-infra-only failures use this retry path. Ordinary build/test/fact failures must still go through correction feedback or existing review-required behavior.

Update `feedback-formatter.test.ts` so review execution failure feedback no longer contains `Report this blocker` or an instruction to call `report_blocker`.

## Risks / pitfalls

Do not broaden retry to all validation failures. Retrying build, test, lint, SAST, smoke, or required-fact failures would hide real agent work and slow pods down.

Be careful with validation history and activity events. It is acceptable to store each infra retry result or only the final result, but the pod activity stream must make retries visible with messages such as `Review infrastructure timeout - retrying in 10s (1/3)`.

Avoid introducing profile-configurable retry settings in this task. That would touch shared/profile/desktop layers and should be a separate feature if needed.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
