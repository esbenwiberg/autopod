# Handover — loose-locust (Brief 02: Daemon Quality Analytics Endpoint)

## What was built

Added the composite `GET /pods/analytics/quality?days=N` endpoint and backing types/repository
method. One round trip returns everything the desktop Quality drill view needs.

### Files changed
- **`packages/shared/src/types/analytics.ts`** — added `QualityAnalyticsResponse` interface
  (references `PodQualityScore[]` via a local import of `./pod.js`).
- **`packages/shared/src/index.ts`** — re-exports `QualityAnalyticsResponse` alongside
  `CostAnalyticsResponse`.
- **`packages/daemon/src/pods/quality-score-repository.ts`** — added `getQualityAnalytics(days)`
  to the `QualityScoreRepository` interface and its implementation in
  `createQualityScoreRepository`. Reads exclusively from `pod_quality_scores` (no new migration).
- **`packages/daemon/src/api/routes/pods.ts`** — registered `GET /pods/analytics/quality` next
  to the Cost and Reliability handlers, with the same `parseDays` / `days > 365` → 400 envelope.
- **`packages/daemon/src/pods/quality-score-repository.test.ts`** — new
  `QualityScoreRepository.getQualityAnalytics` describe block (12 tests).
- **`packages/daemon/src/api/routes/pods.test.ts`** — new `GET /pods/analytics/quality` describe
  block (6 route-level integration tests).

## Response shape (locked contract for Brief 03)

```ts
// packages/shared/src/types/analytics.ts
interface QualityAnalyticsResponse {
  summary: {
    totalPodsScored: number;
    avgScore: number;
    redCount: number;      // score < 60
    yellowCount: number;   // 60..79
    greenCount: number;    // 80..100
    deltaVsPrior: { value: number; direction: 'up' | 'down' | 'flat' };
  };
  sparkline: Array<{ day: string; avgScore: number; podCount: number }>;  // length === days
  distribution: Array<{ bucket: string; count: number }>;  // always 10 entries
  reasons: {
    lowReadEditRatio: number;
    editsWithoutPriorRead: number;
    userInterrupts: number;
    validationFailed: number;
    prFixAttempts: number;
    editChurn: number;
    tells: number;
  };
  scores: PodQualityScore[];
}
```

## Key implementation details

- **Window filter**: `completed_at >= datetime('now', '-N days')` (inclusive lower bound).
  Workspace pods are excluded by the recorder; no extra filter needed in the query.
- **deltaVsPrior**: compared against `datetime('now', '-2N days')` to `datetime('now', '-N days')`.
  Direction is `'flat'` when prior window has zero pods (no division, no NaN).
- **Sparkline fill**: empty days get `{ avgScore: 0, podCount: 0 }` so the desktop sparkline never
  receives a shorter-than-expected array.
- **Histogram**: 10 buckets `0-9 … 90-100` using `Math.min(Math.floor(score / 10), 9)` — score 100
  lands in bucket `90-100` (index 9), not a phantom 11th.
- **Single pass**: summary counts, sparkline buckets, histogram, and reasons are all computed in one
  loop over `scores` (not five separate passes).

## Files the next pod (Brief 03) should NOT modify

- `packages/shared/src/types/analytics.ts` — the `QualityAnalyticsResponse` interface is locked;
  Brief 03 mirrors it field-for-field in Swift.
- `packages/daemon/src/pods/quality-score-repository.ts` — the `getQualityAnalytics` method is
  stable; don't alter the return shape.
- `packages/daemon/src/api/routes/pods.ts` — the route is live; Brief 03 only adds a client call.

## Discovered constraints / landmines

- The `QualityAnalyticsResponse` type imports `PodQualityScore` from `./pod.js`. The Swift mirror
  (`QualityAnalyticsResponse.swift`) must decode `scores` as `[PodQualityScore]` — the camelCase
  field names from the daemon JSON match the existing `CostAnalyticsResponse.swift` precedent
  (no key conversion needed).
- The pre-existing `reliability-aggregator.test.ts` failure
  (`table validations has no column named screenshots`) is unrelated to this brief and was present
  before any changes. All 2324 tests pass on this branch.
- The daemon route test file (`pods.test.ts`) does not use `createTestDb()` from
  `test-utils/mock-helpers.ts`; it re-implements its own `createTestDb()` directly from migration
  files at lines 27–65. This is the established pattern in that file — Brief 03 should follow it if
  it needs to add route tests.
