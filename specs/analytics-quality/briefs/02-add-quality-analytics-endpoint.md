---
title: "Add /pods/analytics/quality composite endpoint"
acceptance_criteria:
  - { type: api, test: "GET /pods/analytics/quality?days=30", pass: "200 with body.summary.totalPodsScored numeric, body.sparkline array, body.distribution length 10, body.reasons object with all 7 fields, body.scores array", fail: "non-200, missing top-level field, distribution length != 10, or reasons missing any of: lowReadEditRatio, editsWithoutPriorRead, userInterrupts, validationFailed, prFixAttempts, editChurn, tells" }
  - { type: api, test: "GET /pods/analytics/quality (no query)", pass: "200 (defaults to days=30) with same shape", fail: "non-200 or missing fields" }
  - { type: api, test: "GET /pods/analytics/quality?days=0", pass: "400 with error message about days >= 1", fail: "non-400 or missing error envelope" }
  - { type: api, test: "GET /pods/analytics/quality?days=400", pass: "400 with error message about days <= 365", fail: "non-400 or missing error envelope" }
touches:
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/pods/quality-score-repository.ts
  - packages/daemon/src/pods/quality-score-repository.test.ts
  - packages/shared/src/types/analytics.ts
  - packages/shared/src/index.ts
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/quality-signals.ts
  - packages/daemon/src/pods/quality-score-recorder.ts
  - packages/desktop/
---

## Task

Ship a new composite analytics endpoint
`GET /pods/analytics/quality?days=N` that returns everything the desktop
Quality drill view needs in one round trip. Mirrors the Cost
(`pods.ts:238`) and Reliability (`pods.ts:252`) precedent — same trailing
window, same validation envelope, same all-in-one payload philosophy.

Add the `QualityAnalyticsResponse` type to `packages/shared` so the
desktop client can mirror it field-for-field in Brief 03.

Add a new aggregation method to `QualityScoreRepository` that the route
calls. The method reads exclusively from `pod_quality_scores` — every
signal needed for the response is already persisted (migrations 055 +
057). No new migration. No event-log scanning.

The new endpoint stands alongside the existing `/pods/scores` and
`/pods/quality/trends` routes; do not remove or modify those.

## Touches

- `packages/shared/src/types/analytics.ts` — add the
  `QualityAnalyticsResponse` interface (full shape in
  `design.md` → Contracts).
- `packages/shared/src/index.ts` — re-export the new type.
- `packages/daemon/src/pods/quality-score-repository.ts` — add a method
  (suggested name `getQualityAnalytics(days: number)`) that returns
  the full response shape. Compose it from existing query helpers
  (`list({ since })` already exists; aggregate in JS for histogram /
  reasons / sparkline, or use SQL — pick whichever is clearer).
- `packages/daemon/src/pods/quality-score-repository.test.ts` —
  coverage for the new method against `createTestDb()` with seeded
  rows.
- `packages/daemon/src/api/routes/pods.ts` — register
  `GET /pods/analytics/quality` next to the Cost and Reliability
  handlers. Validate `days` (default 30, min 1, max 365). Return the
  repository's response object directly.
- `packages/daemon/src/api/routes/pods.test.ts` — route-level integration
  tests modelled on the Reliability block at lines 119–360.

## Does not touch

- `packages/daemon/src/db/migrations/` — no new migration; all signals
  already persisted.
- `packages/daemon/src/pods/quality-signals.ts` —
  `computeQualitySignals` definitions are locked. The endpoint reads
  the persisted columns on `pod_quality_scores`, not the live signal
  computation.
- `packages/daemon/src/pods/quality-score-recorder.ts` — recorder is
  already writing every column the endpoint needs.
- `packages/desktop/` — desktop work happens in Brief 03.

## Constraints

From `design.md` → Contracts: the response shape is locked. Days
defaults to 30, valid range 1..365 inclusive, otherwise return 400
with the existing error envelope used by the Reliability route at
`pods.ts:266+`.

From `design.md` → Reference reading: pod filter — only
`final_status IN ('complete', 'killed')` rows where `completed_at`
falls in the trailing window are included in `summary.totalPodsScored`,
`distribution`, `reasons`, and `scores`. Workspace pods are already
excluded by the recorder.

From `purpose.md` → Glossary: histogram is exactly 10 fixed buckets
labelled `0-9, 10-19, ..., 90-100`; empty buckets must still appear
with `count: 0` so the frontend doesn't have to fill gaps.

From `purpose.md` → Glossary: band thresholds are Red `<60`, Yellow
`60..79`, Green `80..100`. `summary.redCount + yellowCount + greenCount
=== summary.totalPodsScored` must hold.

`deltaVsPrior` is computed against the immediately preceding window of
the same length (precedent: `CostAnalyticsResponse.deltaVsPrior`).
`direction` is `'up'` when current avgScore > prior, `'down'` when
lower, `'flat'` when equal or when prior window has zero pods.

## Test expectations

### Repository tests
- **Empty fleet** — zero rows in `pod_quality_scores` →
  `totalPodsScored === 0`, all reason counts === 0, distribution all
  zeros, sparkline length === days, deltaVsPrior direction === 'flat'.
- **Single pod, score 85** — `summary.greenCount === 1`,
  `distribution[8].count === 1` (bucket 80-89), all reason counts
  reflect that pod's signals.
- **Window boundaries** — pod completed exactly at the window edge is
  included; pod completed one second before is excluded.
  Use `datetime('now', '-30 days')` as the cutoff per
  `quality-score-repository.ts:167` precedent.
- **Reason counters de-duplicate** — a pod with multiple low signals
  contributes 1 to each reason counter (not summed). Confirm by
  seeding a pod with `editsWithoutPriorRead = 5` AND
  `userInterrupts = 2` — each reason counter increments by 1 for
  that pod.
- **deltaVsPrior** — seed two windows, assert direction + value match
  the avg-score difference.
- **Filter to terminal final states** — a pod with
  `final_status = 'killed'` is included; the `pod_quality_scores`
  CHECK constraint already restricts to `'complete' | 'killed'` so
  this is mostly a sanity check.

### Route tests (mirror `pods.test.ts:119-360`)
- 200 happy path with `?days=30`.
- 200 with no query (defaults to 30).
- 400 on `days=0` and `days=400`.
- Error envelope shape matches existing routes.
- Repository injection — instantiate with a `createTestDb()` repo so
  the test exercises real SQL.

### Shared type tests
- If a `analytics.test.ts` exists alongside the type, add a
  shape-roundtrip test for `QualityAnalyticsResponse`. Otherwise skip
  — the type is structural only.

## Risks / pitfalls

- **Aggregation correctness on the histogram.** Bucket boundaries are
  `[0,9], [10,19], ..., [90,100]` — note the last bucket is 11 wide
  (includes 100). Test a score of exactly 100 lands in bucket
  `90-100`, not in a phantom 11th bucket.
- **Sparkline fill.** If the window is 30 days but only 5 days have
  scored pods, the response must still have 30 entries (with
  `avgScore: 0, podCount: 0` on empty days). Otherwise the desktop
  sparkline draws garbage.
- **Sparse windows and `deltaVsPrior`.** When the prior window has
  zero pods, return `direction: 'flat', value: 0` — don't divide by
  zero or NaN out the sparkline math.
- **Don't recompute signals from events.** Read the persisted columns
  on `pod_quality_scores`. Loading `events` per pod for fleet-wide
  aggregation is the wrong shape — the recorder already did this work
  on completion.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
