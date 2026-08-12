---
title: "Emit and hydrate review progress"
touches:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
does_not_touch:
  - packages/shared/src/types/
  - packages/desktop/
  - packages/daemon/src/db/migrations/
---

## Task

Build complete review-progress snapshots from the runner callback, emit them as typed persisted
pod events, and attach the latest active snapshot to full pod hydration. Derive compact validating
card copy without issuing per-pod queries for non-validating pods.

## Touches

- Full-suite Review orchestration and snapshot builder.
- Pod validation callback emission.
- Pod detail and compact-list serialization backed by the existing event repository.
- Focused daemon tests for event continuity and hydration.

## Does not touch

- Database schema or event persistence format.
- Desktop code.
- Review authority, findings, retry, concurrency, or timeout configuration.

## Constraints

- Snapshot timestamps, elapsed time, and guardrail reflect real values.
- Closure is shown only when prior active findings make closure applicable.
- Ordinary replay remains unchanged; pod detail hydration covers cold launch and replay truncation.
- Do not expose stale progress after the Review phase or pod validation is no longer active.

## Test expectations

- Assert five ordered axes exist from the first snapshot.
- Assert unavailable axes increase settled count but not completed count.
- Assert stage changes to synthesis, closure when applicable, and finalizing.
- Assert pod REST hydration recovers a latest persisted snapshot.

## Wrap-up

Report emitted event examples and the focused Linux-executable facts.
