---
title: "Add throughput analytics endpoint"
acceptance_criteria:
  - type: api
    outcome: GET /pods/analytics/throughput?days=30 → 200 with body.summary.podsPerDay (number), body.summary.podsPerDaySparkline (array, length 30), body.summary.podsPerDayDelta, body.summary.mttmSeconds (number), body.summary.backlog (number), body.cohort (array), body.cohortTruncated (boolean), body.queueDepth (array), body.timeInStatus (array, length 4)
    hint: GET /pods/analytics/throughput?days=30
  - type: api
    outcome: GET /pods/analytics/throughput?days=0 → 400 with body.code = 'invalid_days'
    hint: GET /pods/analytics/throughput?days=0
  - type: api
    outcome: GET /pods/analytics/throughput?days=400 → 400 with body.code = 'invalid_days'
    hint: GET /pods/analytics/throughput?days=400
touches:
  - packages/daemon/src/pods/throughput-aggregator.ts
  - packages/daemon/src/pods/throughput-aggregator.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/index.ts
  - packages/shared/src/types/analytics.ts
  - packages/shared/src/index.ts
does_not_touch:
  - packages/desktop/
  - packages/cli/
  - packages/escalation-mcp/
  - packages/validator/
  - packages/daemon/src/db/migrations/
---

## Task

Add `GET /pods/analytics/throughput?days=N` on the daemon. Pure
read/aggregate path — no schema, no writers, no new persistence.
Returns one composite payload covering the headline summary, the
per-pod cohort (for client-side hour×day heatmap bucketing), the
hourly queue-depth time-series, and the four-state time-in-status
box-plot.

The full endpoint shape lives in `design.md` → Contracts. Implement
exactly that shape; do not widen it; do not invent new fields.

### Brief overview of the work

1. **Shared types** — extend
   `packages/shared/src/types/analytics.ts` with
   `LoadBearingStatus`, `ThroughputCohortPod`, `QueueDepthBucket`,
   `TimeInStatusBox`, `ThroughputAnalyticsResponse`. Re-export from
   `packages/shared/src/index.ts`.

2. **Aggregator** — new
   `packages/daemon/src/pods/throughput-aggregator.ts`. Co-located
   with `reliability-aggregator.ts` (same data domain). Export a
   `computeThroughputAnalytics(db, days): ThroughputAnalyticsResponse`
   that runs all queries and assembles the response.

   Two cohorts (NON-NEGOTIABLE — see `design.md` → Cohort discipline):
   - `buildTerminalCohortClause(days)` — for sparkline, MTTM, heatmap
     cohort, time-in-status. Reuse the helper from prior analytics
     phases if it exists; otherwise inline the predicate identically
     and add a `// keep in sync with: ...` comment.
   - `buildQueueIntersectClause(days)` — for queue-depth ONLY. New.
     Document at the top of the aggregator.

   Helper math:
   - `summary.podsPerDay = cohort.length / days`.
   - `summary.podsPerDaySparkline` — group cohort by `date(completed_at)`
     in UTC; pad missing days with `count: 0`; length === days.
   - `summary.podsPerDayDelta` — prior window of identical length
     (mirror Reliability's pattern at
     `reliability-aggregator.ts:248-263`); direction: `up` if
     `value > 0.1`, `down` if `< -0.1`, else `flat`.
   - `summary.mttmSeconds` — mean of `(completed_at - created_at)`
     in seconds, restricted to terminal cohort with status='complete'.
     Returns 0 when no complete pods.
   - `summary.backlog` — `SELECT COUNT(*) FROM pods WHERE status IN
     ('queued', 'provisioning')` at request time. Window-independent.
   - `cohort[]` — terminal cohort, ordered by `completed_at` DESC.
     Cap at 5 000 entries; set `cohortTruncated = true` when capped.
   - `queueDepth[]` — see `design.md` → Queue-depth derivation.
     Hourly buckets, sample at minute boundaries (60 samples/bucket),
     emit `max` and `mean`. Length = `days * 24`.
   - `timeInStatus[]` — walk consecutive `pod.status_changed` events
     from the `events` table for each cohort pod, accumulate per-state
     durations in seconds, compute p25/p50/p75/p90/max in JS over
     sorted lists. Always emit four entries in the fixed order
     `[queued, running, validating, awaiting_input]`; states with
     zero samples emit zeroed stats and `sampleCount: 0`.

3. **Route registration** — extend
   `packages/daemon/src/api/routes/pods.ts`. Mirror the Reliability
   route at `pods.ts:252-262`. Validation envelope and error shape
   per `design.md` → Validation rules. The handler calls
   `computeThroughputAnalytics(db, days)`.

4. **Wiring** — `packages/daemon/src/index.ts` passes the aggregator
   into the route registration alongside the existing reliability /
   quality / safety wiring.

## Touches

- `packages/shared/src/types/analytics.ts` — add new types.
- `packages/shared/src/index.ts` — re-export.
- `packages/daemon/src/pods/throughput-aggregator.ts` — new aggregator.
- `packages/daemon/src/pods/throughput-aggregator.test.ts` — co-located
  unit tests.
- `packages/daemon/src/api/routes/pods.ts` — register the new route.
- `packages/daemon/src/api/routes/pods.test.ts` — extend with route
  integration tests.
- `packages/daemon/src/index.ts` — wire the aggregator.

## Does not touch

- `packages/desktop/` — desktop consumes this contract in Brief 02.
- `packages/cli/` — no CLI surface for throughput.
- `packages/escalation-mcp/`, `packages/validator/` — unrelated.
- `packages/daemon/src/db/migrations/` — no schema change in this
  phase.

## Constraints

- Follow `design.md` → Contracts verbatim. Do not widen the response.
- The two cohort helpers must be named distinctly and used only
  where appropriate (`design.md` → Cohort discipline). The
  queue-intersect cohort is a known footgun.
- Sparkline length always equals `days`; missing days get `count: 0`.
- `timeInStatus` always emits 4 entries in the fixed order
  `[queued, running, validating, awaiting_input]`, even when all are
  zero.
- Use the sub-query pattern from
  `reliability-aggregator.ts:268-275` to avoid hitting
  `SQLITE_MAX_VARIABLE_NUMBER` on large cohorts.
- Pre-event-bus pods (no `pod.status_changed` rows) contribute zero
  samples to time-in-status — assert this in tests.
- Reuse `buildTerminalCohortClause(days)` if a helper from prior
  phases exists (check `reliability-aggregator.ts` and
  `safety-aggregator.ts`). Do not split the predicate across
  conventions.

## Test expectations

`throughput-aggregator.test.ts`:

- **Empty cohort** — returns `summary.podsPerDay: 0`, sparkline of
  length `days` all zero, delta `{ value: 0, direction: 'flat' }`,
  `mttmSeconds: 0`, `backlog: 0` (when no queued/provisioning pods),
  empty `cohort`, `cohortTruncated: false`, `queueDepth` of length
  `days * 24` all-zero, `timeInStatus` of length 4 with all zeros.

- **Trailing-window bucketing** — fixture with completed pods at
  known timestamps inside and just-outside the 30-day window;
  outside-window pods do not appear in `cohort` or sparkline.

- **MTTM cohort** — fixture with mixed terminal statuses
  (complete / killed / failed). MTTM averages only the `complete`
  subset; killed/failed pods do NOT contribute to MTTM but DO
  contribute to `podsPerDay`.

- **Backlog independence** — fixture with `status='queued'` and
  `status='provisioning'` pods that have no `completed_at`. They
  appear in `summary.backlog` regardless of `days`. Pods with
  `status='running'` are excluded from `backlog`.

- **Cohort divergence** — explicit test: a pod created 60 days ago,
  started 1 day ago (still in flight). With `days=30`:
  - Does NOT appear in `cohort[]` (not in terminal cohort).
  - Does NOT appear in `summary.podsPerDay` count.
  - DOES contribute non-zero values to early `queueDepth` buckets
    in the window (the [created_at, started_at) interval intersects
    most of the 30-day window).

- **Queue-depth math** — fixture with two pods overlapping in queue
  for a known interval: assert `max == 2` for the overlapping hour,
  `mean` between 1 and 2 reflecting partial overlap.

- **Time-in-status percentiles** — fixture with one pod that runs
  through queued (60s) → running (300s) → validating (120s) →
  complete. Single-sample percentiles all collapse to the same
  value; assertions on p25/p50/p75/p90/max all equal sample.
  Multi-sample fixture covers the percentile interpolation
  contract.

- **Pre-event-bus pod** — fixture pod in cohort with no
  `pod.status_changed` rows. Contributes to `cohort[]` and
  `podsPerDay` but contributes zero samples to time-in-status.

- **Workspace pods excluded** — fixture pod with
  `output_mode='workspace'`. Excluded from every section
  (sparkline, MTTM, cohort, queueDepth, timeInStatus, backlog —
  workspace pods don't queue normally but the assertion is the
  exclusion).

- **Cohort truncation** — fixture with 5 001 completed pods in
  window. `cohort.length === 5000`, `cohortTruncated === true`,
  rows are most-recent-first by `completed_at`.

- **Prior-window delta** — fixture with current window completing
  300 pods in 30 days (10/day) and prior 30 days completing 60
  pods (2/day). `delta.value ≈ 8`, `direction === 'up'`.

`pods.test.ts` (route-level, mirror Reliability block):

- Default behaviour (`/pods/analytics/throughput` with no `days`)
  uses `days=30`; structural assertion on the response shape (every
  required key present, expected lengths).
- `?days=0` → 400 with `code: 'invalid_days'`.
- `?days=-5` → 400 with `code: 'invalid_days'`.
- `?days=400` → 400 with `code: 'invalid_days'`.
- `?days=abc` → 400 with `code: 'invalid_days'`.
- `?days=90` (boundary) → 200, sparkline length 90,
  queueDepth length 2 160.

## Risks / pitfalls

- **SQLite percentile** — no built-in `PERCENTILE_CONT`. Compute in
  JS over sorted samples. With small N per state (typically
  hundreds, not millions), this is fine. Document the approach in
  the aggregator comment.
- **Variable-number limit** — `SQLITE_MAX_VARIABLE_NUMBER` defaults
  to 999. Cohort sizes can exceed that. Use the sub-query pattern
  from `reliability-aggregator.ts:268-275` for any "WHERE pod_id
  IN (...)" — pass the cohort filter as a sub-query, not as
  spread params.
- **Queue-depth performance** — 90 days × 24 hours × 60 minute
  samples = 129 600 inner counts. Cohort is tight (queue-intersect),
  so each count is fast, but profile in test before merging. If hot,
  switch to event-replay (sweep `events` for queue-status
  transitions and accumulate deltas per minute) — same output
  shape.
- **Cohort cap drift** — if 5 000 ever feels too small, change the
  constant in one place (the aggregator). Don't sprinkle.
- **Status durations spanning request time** — pods currently in a
  load-bearing state (e.g. running right now, no terminal completed_at)
  are not in the terminal cohort, so they don't contribute to
  time-in-status — that's correct. Don't try to "fix" this by
  extending the cohort.
- **`status='paused'` and other transitional states** — the four
  load-bearing states are a closed set per `purpose.md`. Do not
  silently add states.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
