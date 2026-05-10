# Handover — complicated-whippet (Brief 01: Daemon endpoint)

## What was built

`GET /pods/analytics/throughput?days=N` is live on the daemon. The endpoint returns a composite
payload: `summary` (podsPerDay, podsPerDaySparkline, podsPerDayDelta, mttmSeconds, backlog),
`cohort[]` (per-pod terminal entries, capped at 5 000), `cohortTruncated`, `queueDepth[]`
(length = days×24), and `timeInStatus[]` (always 4 entries in fixed order). All 18 unit tests and
6 route-integration tests pass.

## Files owned by this pod — do not modify without good reason

- `packages/daemon/src/pods/throughput-aggregator.ts` — aggregator; the two cohort helpers
  (`terminalCohortWhere` / `queueIntersectWhere`) are critical; mixing them is the known footgun
- `packages/daemon/src/pods/throughput-aggregator.test.ts` — 18 tests

These were added to:
- `packages/shared/src/types/analytics.ts` — 5 new exported types (lines 149-215)
- `packages/shared/src/index.ts` — re-exports of the 5 new types
- `packages/daemon/src/api/routes/pods.ts` — route registration (~line 322)
- `packages/daemon/src/api/routes/pods.test.ts` — throughput test block at end of file

## Contract (Brief 02 must mirror this in Swift)

`ThroughputAnalyticsResponse` is the wire contract — see
`packages/shared/src/types/analytics.ts:188-215`. Key points:

- `summary.podsPerDaySparkline` length always equals `days`
- `queueDepth` length always equals `days * 24`
- `timeInStatus` always 4 entries in this fixed order: `['queued','running','validating','awaiting_input']`
- `cohortTruncated: true` when more than 5 000 terminal pods in window
- `cohort[]` ordered by `completedAt DESC` (most-recent-first)
- `queueDepth[].hour` format: `YYYY-MM-DDTHH:00:00Z` (UTC hour boundary)

## Discovered constraints and landmines

1. **ISO timestamp vs SQLite datetime comparison** — pod timestamps are stored as ISO 8601
   (`'...T...Z'`). SQLite's `datetime('now')` returns `'YYYY-MM-DD HH:MM:SS'`. Comparing them
   directly fails for same-day timestamps because `T` (ASCII 84) > space (ASCII 32). The
   `queueIntersectWhere` clause wraps stored columns in `datetime()` to normalize both sides.
   `terminalCohortWhere` uses `completed_at >= datetime('now', '-N days')` which works because
   SQLite handles the comparison correctly when both sides are normalized.

2. **Two cohorts — never mix them** — `terminalCohortWhere` is for everything except queue-depth.
   `queueIntersectWhere` is for `queueDepth[]` ONLY. Mixing them produces wrong counts (in-flight
   pods would appear in sparkline; complete pods from weeks ago would disappear from queue-depth).

3. **`SQLITE_MAX_VARIABLE_NUMBER`** — the events query uses a sub-query
   (`pod_id IN (SELECT id FROM pods WHERE ...)`) rather than spread params to avoid hitting the
   999-variable limit on large cohorts.

4. **Percentiles in JS** — SQLite 3.45 (WAL mode in use) has no `PERCENTILE_CONT`. Percentiles are
   computed via linear interpolation over a JS-sorted array in `computePercentile()`.

5. **Queue-depth is O(days×24×60×N_queue_pods)** — for days=90 and a tight queue this is
   ~12M iterations in pure JS. Acceptable at current fleet size. If the operator's fleet grows
   significantly, switch to the event-replay variant (sweep `pod.status_changed` events and
   accumulate deltas per minute).

6. **Pre-event-bus pods** — pods with no `pod.status_changed` rows in the `events` table appear
   in `cohort[]` and count toward `podsPerDay` but contribute zero samples to `timeInStatus`.
   This is by design (forward-only convention matching ADR-016).

## Deviations from the brief

None. The implementation follows the design verbatim.
