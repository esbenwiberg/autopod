# Handover: distinguished-horse

## What was built

Added `GET /pods/analytics/reliability?days=N` to the daemon. The endpoint returns a
`ReliabilityAnalyticsResponse` containing:
- `firstPassRate` (0–1) and `firstPassRateSparkline` (per-day rates, `days` entries)
- `firstPassRateDelta` (signed pp diff vs prior window, with up/down/flat direction)
- `funnel.bands` (8 happy-path bands, each with pod count) and `funnel.drops` (leaks with topPods + overflow)
- `stageFailures` (8 stages, ever-failed semantics across attempts)
- `profileHeatmap` (profile × stage failure rates)
- `summary` (topFailureStage, avgReworkCount, totalPodsInWindow)

## Files owned by this pod

Do not modify without good reason:

- `packages/daemon/src/pods/reliability-aggregator.ts` — pure aggregation function + all types
- `packages/daemon/src/pods/reliability-aggregator.test.ts` — unit tests (createTestDb fixtures)
- `packages/daemon/src/api/routes/pods.test.ts` — route integration tests (new file, distinct from prior integration tests)

## Files touched but shared

- `packages/daemon/src/api/routes/pods.ts` — added `db?: Database.Database` as 10th parameter to `podRoutes()` and registered the new route adjacent to the cost-analytics route
- `packages/daemon/src/api/server.ts` — passes `deps.db` as the 10th arg to `podRoutes()`

## Contracts frozen by this pod

The `ReliabilityAnalyticsResponse` shape is frozen (documented in `specs/analytics-reliability-funnel/design.md`). Brief 2 (desktop) consumes this verbatim. Do NOT add, remove, or rename top-level fields. Rate fields are floats in [0,1]; count fields are non-negative integers; `topPods.length <= 10` always.

## Placement decision

Phase 1 (cost) placed its aggregator at `src/pods/cost-aggregation.ts`. This pod matched that placement: `src/pods/reliability-aggregator.ts`. The brief's `src/analytics/` suggestion was overridden per the "consistency with Phase 1 wins" rule.

## Discovered constraints / landmines

- **`parseDays()` is private to `pods.ts`** — the reliability route reuses it by calling the shared helper inline (not exported). If Brief 2 needs days parsing client-side that's in Swift, not here.
- **Smoke stage nesting** — `result.smoke.build` / `result.smoke.health` are the build and health stage entries (not top-level `result.build`). Smoke stage failure = any `result.smoke.pages[].status === 'fail'`. This is unintuitive and a common trap.
- **Pre-event-bus pods** — pods with no `pod.status_changed` events are excluded from `funnel.drops` but still count in `firstPassRate`, `stageFailures`, and `summary`. This is intentional and comments explain it.
- **`completed_at` on failed pods** — verified in pod-manager.ts (line ~4304) and local-reconciler.ts that `completedAt` is set for `failed` status transitions. The cohort filter works correctly for all three terminal statuses.
- **`profile_name` column** — pods table uses `profile_name` (denormalized string), not a FK. The aggregator reads this directly.
- **`output_mode != 'workspace'`** — the worker-pod filter. Phase 1 used `agentMode !== 'interactive'`; this pod uses the literal SQL clause per the design doc. Both exclude workspace pods.

## Test coverage

- 20+ unit test cases in `reliability-aggregator.test.ts` (empty cohort, first-pass, rework, drops, overflows, sparkline length/ordering, delta thresholds, workspace exclusion, smoke nesting, canonical stage ordering, tie-breaking)
- Route-level tests in `pods.test.ts`: shape validation, days validation (0/400/30/missing), workspace exclusion
- All 2192 daemon tests pass as of this pod
