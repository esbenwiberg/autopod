---
title: "Add helper cost and fallback visibility"
touches:
  - packages/shared/src/types/pod.ts
  - packages/daemon/src/pods/cost-aggregation.ts
  - packages/daemon/src/pods/cost-aggregation.test.ts
  - packages/daemon/src/pods/pod-cost-breakdown.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
does_not_touch:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/pre-submit-review.ts
---

## Task
Add `helper` as a first-class harness phase and cost bucket, then wire helper
token usage and fallback visibility through the pod manager. Helper token usage
must not pollute `review`, `plan_eval`, or `advisory`. Pod activity must be
emitted only for final user-visible deterministic/template fallback;
intermediate live-container or helper-container failures are structured logs
only.

## Touches
- `packages/shared/src/types/pod.ts`
- `packages/daemon/src/pods/cost-aggregation.ts`
- `packages/daemon/src/pods/cost-aggregation.test.ts`
- `packages/daemon/src/pods/pod-cost-breakdown.ts`
- `packages/daemon/src/pods/pod-manager.ts`
- `packages/daemon/src/pods/pod-manager.test.ts`

## Does not touch
- `packages/daemon/src/validation/local-validation-engine.ts`
- `packages/daemon/src/validation/pre-submit-review.ts`

## Constraints
Adding a phase is a shared analytics contract. Follow ADR-032. Keep helper
cost in the harness side. Preserve existing activity messages for PR template
fallback and memory deterministic fallback, but do not add activity for
intermediate helper stage misses.

## Test expectations
Extend cost aggregation and pod-manager tests for helper cost segment ordering,
known phase recognition, token accumulation, and final-degradation-only
activity.

## Wrap-up
Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
