---
title: "Define live review progress contract"
touches:
  - packages/shared/src/types/validation.ts
  - packages/shared/src/types/events.ts
  - packages/daemon/src/interfaces/validation-engine.ts
  - packages/daemon/src/validation/review-batch-runner.ts
  - packages/daemon/src/validation/review-batch-runner.test.ts
does_not_touch:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/desktop/
---

## Task

Define additive live Review progress types and extend the frozen review runner's safe progress
callback so downstream code can construct independently renderable snapshots. Report axes,
attempts, terminal axis outcomes, and synthesis start/completion. Preserve ADR-036 execution and
verdict semantics exactly.

## Touches

- Shared review snapshot, stage, and axis-state types.
- Shared `pod.review_progress` system event type.
- Validation callback seam used by the daemon.
- Frozen runner progress reporting and focused tests.

## Does not touch

- Pod event emission or REST hydration.
- Desktop decoding or presentation.
- Council concurrency, timeout, retry, findings, synthesis authority, or fail-closed behavior.

## Constraints

- Progress payloads contain no prompts or provider output.
- Every eventual event is a full snapshot, not a delta.
- `settled` means completed or unavailable; unavailable is never labeled completed.
- Stage values are axes, synthesis, closure, and finalizing.

## Test expectations

- Prove retry and unavailable transitions.
- Prove synthesis starts only after all axes settle.
- Prove the shared deadline passed to reviewer work remains unchanged.

## Wrap-up

Report the exact additive contract and focused test command. Do not claim UI coverage.
