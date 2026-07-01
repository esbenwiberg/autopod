---
title: "Preserve validation review boundaries"
touches:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.test.ts
  - packages/daemon/src/validation/pre-submit-review.ts
  - packages/daemon/src/pods/pod-bridge-validation.test.ts
  - packages/daemon/src/validation/review-tool-runner.ts
does_not_touch:
  - packages/daemon/src/worktrees/pr-description-generator.ts
  - packages/daemon/src/providers/memory-reviewer.ts
---

## Task
Preserve the blocking validation reviewer boundary while the best-effort helper
system lands. MAX/container task review and pre-submit review should continue
to hook into the live pod where they already do. Validation review token usage
must stay under `review`, not `helper`.

## Touches
- `packages/daemon/src/validation/local-validation-engine.ts`
- `packages/daemon/src/validation/local-validation-engine.test.ts`
- `packages/daemon/src/validation/pre-submit-review.ts`
- `packages/daemon/src/pods/pod-bridge-validation.test.ts`
- `packages/daemon/src/validation/review-tool-runner.ts`

## Does not touch
- `packages/daemon/src/worktrees/pr-description-generator.ts`
- `packages/daemon/src/providers/memory-reviewer.ts`

## Constraints
Do not rewrite validation task-review or deep-review architecture in this
feature. This brief exists to prove the shared helper migration did not
accidentally pull blocking validation into the best-effort helper path.

## Test expectations
Add or update regression tests for phase token attribution, MAX/container task
review, live-pod pre_submit_review, and Foundry/OpenAI validation review
routing.

## Wrap-up
Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
