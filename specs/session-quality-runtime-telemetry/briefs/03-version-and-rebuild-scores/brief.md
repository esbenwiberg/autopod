---
title: "Version and rebuild quality scores"
touches:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/quality-score-repository.ts
  - packages/daemon/src/pods/quality-score-repository.test.ts
  - packages/daemon/src/pods/quality-score-recorder.ts
  - packages/daemon/src/pods/quality-score-recorder.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/index.ts
does_not_touch:
  - packages/desktop/
  - packages/daemon/src/runtimes/
---

## Task

Add algorithm-version and availability semantics to persisted quality scores. Recompute recoverable Codex history from retained events and represent discarded historical Pi evidence as unavailable rather than inventing counters.

## Touches

- `packages/daemon/src/db/migrations/`
- `packages/daemon/src/pods/quality-score-repository.ts`
- `packages/daemon/src/pods/quality-score-repository.test.ts`
- `packages/daemon/src/pods/quality-score-recorder.ts`
- `packages/daemon/src/pods/quality-score-recorder.test.ts`
- `packages/daemon/src/api/routes/pods.ts`
- `packages/daemon/src/api/routes/pods.test.ts`
- `packages/daemon/src/index.ts`

## Does not touch

- `packages/desktop/`
- `packages/daemon/src/runtimes/`

## Constraints

Check the highest migration prefix immediately before creating the additive migration; duplicate prefixes are a silent schema bug. Backfill must be idempotent, bounded, and safe to rerun at daemon startup or through the chosen repository seam.

Respect ADR-034: one logical pod outcome across provider attempts, aggregate accounting without multiplying outcomes, and compatibility for legacy pods. Analytics must not silently mix incompatible algorithm versions. Do not fabricate historical evidence that was not persisted.

## Test expectations

Cover migration defaults, current-version writes, stale-version selection, retained-event Codex recomputation, unavailable unrecoverable rows, idempotent reruns, and route/analytics filtering. Use in-memory SQLite with all migrations through `createTestDb()`.

## Risks / pitfalls

A repository-wide historical scan can slow startup. Keep it bounded or select only stale rows, and make progress/retry behavior deterministic. Existing rows may contain mixed provider attempts, so recomputation must use the normalized event stream and preserve one pod denominator.

## Wrap-up

Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
