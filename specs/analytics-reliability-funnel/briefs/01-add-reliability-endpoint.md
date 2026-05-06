---
title: "Add reliability analytics endpoint"
depends_on: []
acceptance_criteria:
  - { type: api, test: "GET /pods/analytics/reliability?days=30", pass: "200 with body.funnel.bands.length === 8 and body.firstPassRate is a number between 0 and 1", fail: "non-200 or wrong band count or firstPassRate out of [0,1]" }
  - { type: api, test: "GET /pods/analytics/reliability?days=30 (with seeded multi-stage failure pod)", pass: "body.stageFailures contains an entry with podsFailed >= 1 and body.summary.topFailureStage is non-empty", fail: "stageFailures empty or topFailureStage empty when seeded data has a failure" }
  - { type: api, test: "GET /pods/analytics/reliability?days=30 (with seeded killed pod that died at 'running' band)", pass: "body.funnel.drops contains an entry with from='running' and to='killed' and count >= 1", fail: "drops empty or seeded drop missing" }
touches:
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/analytics/reliability-aggregator.ts
  - packages/daemon/src/analytics/reliability-aggregator.test.ts
  - packages/daemon/src/api/routes/pods.test.ts
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/pod-manager.ts
  - packages/desktop/
  - packages/shared/src/types/
---

## Task

Add `GET /pods/analytics/reliability?days=N` to the daemon. Returns
the `ReliabilityAnalyticsResponse` shape from `design.md` →
Contracts. The endpoint is read-only, runs no migrations, and
introduces no new tables.

### File layout

Place the aggregator at
`packages/daemon/src/analytics/reliability-aggregator.ts`. **Before
creating the directory**, check where Phase 1's cost aggregator
lives (Brief 03 of `specs/analytics-cost/`). If it lives at
`src/analytics/cost-aggregator.ts`, match it. If Phase 1 placed
the aggregator inline in `pods.ts` or under `src/pods/`, match
*that* placement to avoid splitting the analytics surface across
folders. The choice is "consistency with Phase 1 wins" — do not
relitigate.

### Endpoint registration

In `packages/daemon/src/api/routes/pods.ts`, add the route
adjacent to the cost-analytics route (introduced by Phase 1):

```ts
fastify.get('/pods/analytics/reliability', async (request) => {
  const { days } = request.query as { days?: string };
  const window = Number.parseInt(days ?? '30', 10);
  if (!Number.isFinite(window) || window <= 0 || window > 365) {
    throw new Error('days must be a positive integer <= 365');
  }
  return computeReliabilityAnalytics(db, window);
});
```

`computeReliabilityAnalytics` is exported from the aggregator
module. The route handler does no aggregation itself — keep it a
thin glue layer matching Phase 1.

### Aggregator module

The aggregator runs four read-only SQL queries (or fewer, if a
single query fits cleanly) over the trailing-window terminal
cohort:

1. **Cohort + per-pod metrics** — pods filtered by terminal cohort
   clause (`output_mode != 'workspace' AND status IN ('complete',
   'killed', 'failed') AND completed_at >= datetime('now', '-' ||
   :days || ' days')`), selecting `id, profile, status,
   completed_at, rework_count`.

2. **Status change events** — `SELECT pod_id, payload FROM events
   WHERE type = 'pod.status_changed' AND pod_id IN (<cohort
   ids>)`. Group by pod, derive each pod's set of bands reached
   (`payload->>'newStatus'` ∈ the 8 happy-path bands). The "last
   band reached" is the highest band the pod ever entered; that's
   the drop's `from` for non-`complete` pods.

3. **Validations** — `SELECT pod_id, attempt, result FROM
   validations WHERE pod_id IN (<cohort ids>)`. `result` is JSON
   conforming to `ValidationResult`. For each pod, derive the set
   of stages run and the set of stages that ever failed.

4. **First-pass sparkline** — group cohort pods by
   `date(completed_at)` and compute per-day rate:
   `count(status='complete' AND rework_count=0) / count(*)`. Days
   with zero pods emit `rate: 0`. Output exactly `days` entries
   covering the trailing window (most recent day last).

5. **Delta** — re-run the first-pass rate query for the prior
   window of equal length (`days_ago BETWEEN N AND 2N-1`).
   `firstPassRateDelta.value = (current - prior) * 100`
   (percentage points). Direction: `'up'` if value > 0.5, `'down'`
   if value < -0.5, else `'flat'`.

The aggregator is pure: take the SQLite handle and `days`,
return a `ReliabilityAnalyticsResponse`. All time bucketing uses
SQLite's `date()` and `datetime()` — no Node-side date math.

### Helper: `buildTerminalCohortClause(days)`

Mirror whatever Phase 1's cost aggregator did to construct its
terminal-cohort filter. If Phase 1 inlined the clause, inline
yours; if Phase 1 extracted a helper, import or duplicate the
helper. Do not refactor Phase 1 to share — Phase 1 froze that
shape.

### Funnel drop classification

For each cohort pod with `status !== 'complete'`:

- Walk the pod's `pod.status_changed` events ordered by
  `timestamp` ASC.
- Build the set of `newStatus` values that are happy-path bands.
- The pod's "last band reached" is the band with the highest
  index in `BANDS` (where `BANDS = ['queued', 'provisioning',
  'running', 'validating', 'validated', 'approved', 'merging',
  'complete']`).
- Emit a drop entry `(from = lastBandReached, to = pod.status)`.

Group by `(from, to)`. For each group, build `topPods` by ordering
the group's pod list by `completed_at` DESC and taking the first
10. `overflow = max(0, count - 10)`.

Edge case: a pod whose status went straight from `queued` to
`failed` (no `running` band ever entered) drops at `from =
'queued'`. A pod that has *no* `pod.status_changed` events at all
(legacy / pre-event-bus pods) is excluded from drops — its data
is unrecoverable. Note this exclusion in the aggregator's source
as a one-line comment.

### Stage failure derivation

For each cohort pod, walk all its `validations.result` rows. For
each stage in the 8 (`build`, `health`, `smoke`, `test`, `lint`,
`sast`, `acValidation`, `taskReview`):

- `podsRan += 1` if any attempt has the stage non-null.
- `podsFailed += 1` if any attempt has that stage's `status ===
  'fail'`. The `smoke` stage is special — its `result.smoke`
  contains nested `build`, `health`, and `pages`. For
  `stageFailures.smoke`, treat the pod as failed at smoke if any
  `pages` entry has `status === 'fail'`. For `stageFailures.build`
  / `health`, read from `result.smoke.build` / `result.smoke.health`
  respectively (not `result.build`, which doesn't exist).

`failureRate = podsFailed / podsRan` (rounded to 4 decimals to
keep JSON tidy), or `0` when `podsRan === 0`.

### Profile heatmap derivation

For each unique `profile` in the cohort:
- For each stage that ANY pod with that profile ran, emit a stage
  entry with the same `(podsRan, podsFailed, failureRate)` math
  scoped to that profile.
- Stages with `podsRan === 0` for the profile are omitted from
  the profile's `stages` array.

Sort profiles alphabetically. Sort each profile's `stages` array
in the canonical 8-stage order (build, health, smoke, test, lint,
sast, acValidation, taskReview).

### Summary

- `topFailureStage`: the stage in `stageFailures` with the highest
  `failureRate`. Ties → highest `podsFailed`. Further ties →
  alphabetical. Empty string `''` if no stage has any failures.
- `avgReworkCount`: `cohort.reduce((s, p) => s + p.reworkCount, 0)
  / cohort.length`, or `0` for empty cohort. No rounding.
- `totalPodsInWindow`: `cohort.length`.

## Touches

- `packages/daemon/src/api/routes/pods.ts` — register the route.
- `packages/daemon/src/analytics/reliability-aggregator.ts` (new)
  — aggregation function + helpers.
- `packages/daemon/src/analytics/reliability-aggregator.test.ts`
  (new) — unit tests against `createTestDb()` fixtures.
- `packages/daemon/src/api/routes/pods.test.ts` — endpoint tests
  using `app.inject()`.

## Does not touch

- `packages/daemon/src/db/migrations/` — no schema change.
- `packages/daemon/src/pods/pod-manager.ts` — pure read endpoint.
- `packages/desktop/` — Brief 02.
- `packages/shared/src/types/` — the response type lives in the
  daemon (mirrored on Swift side by Brief 02). Do not export it
  through `@autopod/shared`; nothing else needs it server-side.

## Constraints

From `design.md` → Contracts: shape is frozen. All counts are
non-negative integers; rates are floats in `[0,1]`. `topPods.length
<= 10` always; `overflow >= 0` always.

From `purpose.md` → Reversibility: endpoint is additive,
read-only, can be removed without migration.

From `design.md` → Reference reading: the 8-stage taxonomy and
band set are pinned by existing types. Do not invent stages or
bands. If a future PodStatus is added that isn't in the band set,
it remains a side-track unless this brief is re-opened.

## Test expectations

In `reliability-aggregator.test.ts` (using `createTestDb()`):

- **Empty cohort** — no pods in window. Response:
  `firstPassRate: 0`, `firstPassRateSparkline.length === days`,
  all entries `rate: 0`, `funnel.bands` all `count: 0`,
  `funnel.drops: []`, `stageFailures.length === 8` all
  `podsRan: 0`, `profileHeatmap: []`, `summary.topFailureStage:
  ''`, `summary.totalPodsInWindow: 0`.

- **First-pass single pod** — one pod `complete`, `reworkCount=0`,
  events showing all 8 bands. Result: `firstPassRate: 1`, no
  drops, all bands `count: 1`.

- **Reworked pod** — one pod `complete`, `reworkCount=2`. Result:
  `firstPassRate: 0`. Pod still counted in band 8.

- **Killed at running** — one pod `status='killed'`,
  `events: [queued→provisioning→running]`. Result:
  `funnel.drops: [{ from: 'running', to: 'killed', count: 1,
  topPods: [<that pod>], overflow: 0 }]`.

- **Failed at validating** — one pod `status='failed'`, events
  reach validating. Drop: `(validating, failed)`.

- **Stage failure on smoke** — one pod with
  `validations.result.smoke.pages = [{ status: 'fail', ... }]`.
  Result: `stageFailures.smoke.podsFailed >= 1`,
  `summary.topFailureStage = 'smoke'`.

- **Multi-attempt accumulation** — pod has two validation rows
  (attempt 0 fails test, attempt 1 passes everything). Pod still
  counts in `stageFailures.test.podsFailed` (ever-failed
  semantics).

- **Profile heatmap exclusion** — pod with profile X never ran
  `sast`. Heatmap entry for X has no `sast` stage in its
  `stages` array.

- **Drop overflow** — 12 pods drop at the same `(running,
  failed)` pair. Result: `topPods.length === 10`, `overflow ===
  2`. Order is `completedAt DESC`.

- **Sparkline length** — `days=7` → exactly 7 entries; most
  recent day is the last entry.

- **Delta direction thresholds** — first-pass rate change of
  +0.6pp → `direction: 'up'`. Change of -0.4pp → `'flat'`.

In `pods.test.ts`:

- **Endpoint round-trip** — `app.inject({ method: 'GET', url:
  '/pods/analytics/reliability?days=30' })` returns 200 with the
  full response shape (validate one field per top-level key).

- **`days` validation** — `days=0` returns 400-ish (whatever the
  existing route error pattern is). `days=400` rejected.
  `days=30` accepted. Missing `days` defaults to 30.

- **Workspace exclusion** — seed a workspace pod (`output_mode =
  'workspace'`) with `status='complete'`. Confirm it does NOT
  contribute to any field in the response.

## Risks / pitfalls

- **`smoke` stage nesting** — `result.smoke` contains
  `{ build, health, pages }`. The "smoke stage failed" semantic
  is "any page failed". Meanwhile the `build` and `health`
  *stages* in `stageFailures` read from `result.smoke.build` and
  `result.smoke.health`. Three stage names share one JSON
  subtree; don't conflate them.

- **`overall: 'fail'` is not a stage** — a pod with
  `result.overall = 'fail'` and all individual stages passing
  isn't a stage failure for `stageFailures` purposes. `overall`
  is informational; per-stage failures drive the metric.

- **Pre-event-bus pods** — pods created before the
  `pod.status_changed` event bus existed have no events. They're
  in the cohort (status is set), but they have no derivable
  drop. Skip them silently in the funnel; they still count in
  `firstPassRate` and `stageFailures` and `summary`.

- **Recovered pods skip bands** — a recovered pod
  (`recoveryWorktreePath` set) re-enters `provisioning` mid-flight
  via a `pod.status_changed` event. It will have multiple
  `provisioning` entries in events; dedupe by `newStatus` per
  pod when computing `bands`. The "last band reached" is still
  well-defined — take the max-indexed band from the dedup'd set.

- **`completed_at` on failed pods** — verify failed pods get
  `completed_at` set. If they don't (the pod-manager only sets
  it on `complete`/`killed`), the cohort filter misses them.
  Spot-check the codebase: search for `completed_at = ` writes in
  `pod-repository.ts` and confirm `failed` is also set. If not,
  expand the cohort clause to `completed_at IS NOT NULL OR status
  IN ('failed')` and use `created_at + finalEventTimestamp` as a
  fallback. Brief writer note: this needs verification at brief
  start, not assumed.

- **JSON path syntax** — SQLite's JSON1 extension uses
  `payload->>'newStatus'` (json_extract shorthand). Confirm the
  events table stores `payload` as a TEXT column with JSON
  content. If it's stored differently (separate columns), the
  query shape changes; read the events schema before writing the
  query.

- **Profile column** — pods may store profile as `profile_id`
  (FK) or `profile` (denormalized name). Read
  `pod-repository.ts` to confirm; the response uses the profile
  *name*, not ID.

## Wrap-up

1. Run `/simplify` and address findings.
2. `npx pnpm build` — passes (transitive type-check).
3. `npx pnpm --filter @autopod/daemon test` — passes.
4. Commit and push.
