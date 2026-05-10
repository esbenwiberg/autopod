# Design — Analytics Throughput

## Blast radius

### Daemon (Brief 01)
- `packages/daemon/src/pods/throughput-aggregator.ts` (new) — pure
  aggregation function from raw query rows to
  `ThroughputAnalyticsResponse`. Co-located with Phase 2's
  `reliability-aggregator.ts` (same data domain: pods table).
- `packages/daemon/src/pods/throughput-aggregator.test.ts` (new) —
  unit tests for cohort selection, MTTM math, queue-depth bucketing,
  time-in-status percentiles, sparkline padding, prior-window delta.
- `packages/daemon/src/api/routes/pods.ts` (modify) — register
  `GET /pods/analytics/throughput`. Mirror the Reliability route
  registration pattern at `pods.ts:252-262`; do not refactor adjacent
  routes.
- `packages/daemon/src/api/routes/pods.test.ts` (modify) — extend
  with route-level integration tests modelled on the Reliability block
  at `pods.test.ts:119+`.
- `packages/daemon/src/index.ts` (modify) — wire the new aggregator
  into the route registration, alongside the existing reliability /
  quality / cost / safety wiring.

### Shared types (Brief 01)
- `packages/shared/src/types/analytics.ts` (modify) — add
  `ThroughputAnalyticsResponse` plus the `LoadBearingStatus`,
  `QueueDepthBucket`, `TimeInStatusBox`, `ThroughputCohortPod` helper
  types.
- `packages/shared/src/index.ts` (modify) — re-export the new types.

### Desktop (Brief 02)
- `packages/desktop/Sources/AutopodClient/Types/ThroughputAnalyticsResponse.swift`
  (new) — Codable mirror of the TS contract.
- `packages/desktop/Tests/AutopodClientTests/ThroughputAnalyticsResponseTests.swift`
  (new) — JSON-decode coverage modelled on
  `ReliabilityAnalyticsResponseTests.swift`.
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` (modify) —
  add `getThroughputAnalytics(days:)` next to
  `getReliabilityAnalytics`/`getQualityAnalytics`/`getSafetyAnalytics`.
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift`
  (modify) — extend the enum with `.throughput`. Existing exhaustive
  switches will fail to compile until they handle the new case — do
  that in the same brief.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`
  (modify) — add `.throughput` switch case routing to the new drill
  view.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift`
  (modify) — Throughput card data wiring (value =
  `String(format: "%.1f", summary.podsPerDay)`, sparkline =
  `summary.podsPerDaySparkline.map(\.count)`, delta =
  `summary.podsPerDayDelta`, sub-line per UX-flows section).
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ThroughputDrillView.swift`
  (new) — three-section drill with days picker; structure mirrors
  `QualityDrillView` and `ReliabilityDrillView`.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift`
  (modify) — pass `loadThroughputAnalytics` closure into the existing
  `AnalyticsView(...)` call site.

## Seams

Two briefs, one pod boundary.

1. **Daemon endpoint (Brief 01)** — owns the aggregator, the route,
   and the TS contract. Foundation for Brief 02.
2. **Desktop card + drill (Brief 02)** — consumes the contract from
   Brief 01 verbatim. Hard sequential dependency.

Brief order:
- 01 ships first (sequential).
- 02 must follow 01 (contract dependency + file overlap on
  `MainView.swift` + `AnalyticsCardKind.swift` does not exist between
  briefs since Brief 01 doesn't touch those files; the hard dep is
  the contract).

## Contracts

`ThroughputAnalyticsResponse` is the only cross-pod contract on the
wire. Brief 01 owns the TS source; Brief 02 mirrors in Swift.

```ts
// packages/shared/src/types/analytics.ts (added in Brief 01)

/** The four states pods spend meaningful time in. The other 12
 *  PodStatus values are transitional and excluded by design. */
export type LoadBearingStatus =
  | 'queued'
  | 'running'
  | 'validating'
  | 'awaiting_input';

export interface ThroughputCohortPod {
  podId: string;
  profile: string;
  status: 'complete' | 'killed' | 'failed';
  /** ISO UTC. Desktop buckets in the user's local timezone. */
  completedAt: string;
}

export interface QueueDepthBucket {
  /** ISO UTC hour boundary (e.g. '2026-05-09T14:00:00Z'). One entry
   *  per hour in the window. */
  hour: string;
  /** Max queue depth observed during this hour. */
  max: number;
  /** Mean queue depth during this hour, sampled at minute boundaries
   *  (60 samples per bucket; aggregator computes the mean of those). */
  mean: number;
}

export interface TimeInStatusBox {
  status: LoadBearingStatus;
  /** Seconds. p25/p50/p75 form the box, p90 is the whisker, max is
   *  the outlier marker. All zero when sampleCount === 0. */
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  max: number;
  sampleCount: number;
}

export interface ThroughputAnalyticsResponse {
  /** High-level totals over the trailing window. Cohort = terminal:
   *  output_mode != 'workspace' AND status IN ('complete','killed','failed')
   *  AND completed_at IN window. */
  summary: {
    /** Mean pods-per-day across the window. = |cohort| / days.
     *  Returns 0 when cohort is empty. */
    podsPerDay: number;

    /** One entry per day in window (length === days). count = pods
     *  whose completed_at falls in that local-UTC day. Days with zero
     *  terminal pods emit count = 0. */
    podsPerDaySparkline: Array<{ day: string; count: number }>;

    /** Direction: 'up' when value > 0.1, 'down' when < -0.1, 'flat'
     *  otherwise. value = signed difference in mean pods/day vs the
     *  immediately-prior window of the same length. */
    podsPerDayDelta: {
      value: number;
      direction: 'up' | 'down' | 'flat';
    };

    /** Mean time-to-merge across the cohort, restricted to pods
     *  with status='complete'. Seconds. = mean(completed_at -
     *  created_at). Returns 0 when no complete pods in window. */
    mttmSeconds: number;

    /** Live point-in-time count: pods with status IN
     *  ('queued','provisioning') at request time. Window-independent. */
    backlog: number;
  };

  /** Per-pod entries from the terminal cohort. Desktop buckets these
   *  client-side into hour-of-day × day-of-week cells in the user's
   *  local timezone. Capped at 5 000 entries (largest expected for
   *  a 90-day window of an active fleet); on overflow, returns the
   *  most-recent 5 000 ordered by completedAt DESC and emits
   *  cohortTruncated=true. */
  cohort: ThroughputCohortPod[];
  cohortTruncated: boolean;

  /** Hourly queue-depth time-series over the window. Cohort =
   *  queue-intersect (pods whose [created_at, started_at) interval
   *  intersects the window — INCLUDING in-flight pods that haven't
   *  completed). One entry per hour, length = days * 24. */
  queueDepth: QueueDepthBucket[];

  /** Box-plot stats per load-bearing state. Always 4 entries in the
   *  fixed order [queued, running, validating, awaiting_input].
   *  States with sampleCount === 0 still emit a row with zeroed stats. */
  timeInStatus: TimeInStatusBox[];
}
```

### Validation rules (mirror Reliability/Quality/Safety)
- `days` defaults to `30`.
- `days < 1` → `400 { error: 'days must be a positive integer', code: 'invalid_days' }`.
- `days > 365` → `400` with the same code.

### Cohort discipline (NON-NEGOTIABLE)

Two cohorts in one endpoint — easy to mix up. Name them distinctly in
the aggregator and consume them only where they belong:

| Section            | Cohort                | Bucket key      |
|--------------------|----------------------|------------------|
| `summary.podsPerDay` + sparkline + delta | terminal | `completed_at` daily bucket |
| `summary.mttmSeconds` | terminal ∩ status='complete' | n/a (mean) |
| `summary.backlog` | live | `status IN ('queued','provisioning')` at NOW |
| `cohort[]` | terminal | per-pod row |
| `queueDepth[]` | **queue-intersect** | hourly bucket over UTC window |
| `timeInStatus[]` | terminal (durations from `events`) | per-state |

Reuse `buildTerminalCohortClause(days)` from prior phases (extracted
during analytics-reliability-funnel; see if/where it landed and use
the same helper. If it never got extracted to a helper, inline the
predicate identically and add a `// keep in sync with: ...` comment).

The queue-intersect cohort needs its own helper:
`buildQueueIntersectClause(days)` — `created_at < datetime('now') AND
(started_at IS NULL OR started_at >= datetime('now', '-' || @days ||
' days'))`. Document it once at the top of the aggregator.

### Queue-depth derivation

For each hour `h` in `[window_start, window_end]`, compute:
- `depth(t) = COUNT(pods WHERE created_at <= t AND (started_at > t OR
  started_at IS NULL))`
- `max_h = max(depth(t)) for t in {h, h+1m, h+2m, ..., h+59m}`
- `mean_h = mean(depth(t)) for the same minute samples`

Implementation: for each hour bucket sample at 60 minute boundaries.
With `days=90`, that's 90 × 24 × 60 = 129 600 samples and a single
COUNT per sample, but the cohort is small (queue-intersect only) and
SQLite handles this in well under 200ms in practice. If load tests
show hot spots, switch to the event-replay variant (sweep `events`
where `type='pod.status_changed'` and `newStatus IN ('queued',
'provisioning','running')` and compute deltas) — keep the same shape.

### Time-in-status derivation

For each cohort pod, walk consecutive `events` rows where
`type='pod.status_changed'` ordered by `created_at`. For every entry
where `payload.newStatus ∈ load-bearing`, compute the duration until
the next `pod.status_changed` event for that pod (or until
`completed_at` if it's the last status). Sum durations are *per-state*
across pods; percentiles computed in JS over the sorted list (SQLite
3.45 in WAL mode — no built-in PERCENTILE_CONT yet). Pre-event-bus
pods (no `pod.status_changed` rows) contribute zero samples and are
excluded from the per-state sample count, identical to the reliability
funnel's pod-bands handling at
`reliability-aggregator.ts:296-298`.

## UX flows

### Sidebar
The locked Phase 0 contract — single `Analytics` row plus disabled
sub-rows. This phase does *not* enable a sub-row (no per-section sub
route; the card grid is the only entry point). If a `Throughput`
sub-row exists in the sidebar from Phase 0, leave it disabled.

### Overview — Throughput card
Same `AnalyticsCard` API as the others (`AnalyticsView.swift:84-96`):

- **value:** `String(format: "%.1f", summary.podsPerDay)` (one-decimal
  float). When `summary.podsPerDay == 0`: value = `"0"`.
- **sparkline:** `summary.podsPerDaySparkline.map(\.count)`. Empty
  cohort → nil sparkline.
- **delta:** `AnalyticsCardDelta` formatted as
  `String(format: "%+.1f", summary.podsPerDayDelta.value) + " /day"`,
  direction mapped from `summary.podsPerDayDelta.direction`. Empty
  cohort: nil.
- **sub-line under value:** `"MTTM Xh Ym · N in queue"` where
  - `MTTM` formats as `Xh Ym` when seconds ≥ 3600, else `Ym` when
    ≥ 60, else `Ns`. Suppressed when `mttmSeconds == 0` (no complete
    pods in window).
  - `N in queue` reads `summary.backlog`. Suppressed when `backlog ==
    0`.
  - Middle dot is U+00B7. Whole sub-line suppressed when *both* parts
    suppress.
- **isSelected / onClick:** unchanged from the existing pattern.

### Drill view — `ThroughputDrillView`

Header (sticky inside the right-pane scroll):
- **Days picker:** numeric stepper or menu; default 30; values
  `7 / 14 / 30 / 60 / 90`. Re-fetches
  `/pods/analytics/throughput?days=N`.

Body, in scroll order:

1. **Hour-of-day × day-of-week heatmap** — grid of 7 rows × 24
   columns (or transposed if it reads better; pick at implementation
   time and document in the brief). Cell color is a
   `Color.accent.opacity(count / maxCount)` overlay; cell label
   shows the count. Cells with `count > 0` are clickable: clicking
   expands an inline `DisclosureGroup` listing up to 10 pods
   (ordered by `completedAt` DESC) plus an `+ N more` indicator
   when overflow > 0. Each pod row is clickable → fires
   `onSelectPod(podId)`. **Bucketing happens client-side** from
   `cohort[].completedAt` ISO using `Calendar.current` (user's
   local TZ). When `cohortTruncated == true`, a small "showing the
   most recent 5 000 of N pods" caption appears beneath the
   heatmap. Empty state: `"No completed pods in last N days."`.

2. **Queue-depth time-series** — line chart over `queueDepth`.
   Two visual layers:
   - `mean` rendered as a shaded area from baseline.
   - `max` rendered as a solid line on top of the area.
   X-axis is local time (user TZ); Y-axis is depth (pods). Empty
   state: `"No queue history in last N days."` (also shown when
   queueDepth array is all-zero).

3. **Time-in-status box plot** — `Chart` with one row per
   `LoadBearingStatus`, in the fixed order shown above. Each row
   shows: a horizontal bar from p25 to p75 (the box), a vertical
   marker at p50, a whisker line from p75 to p90, and a small dot
   at max. Underneath each row the label reads
   `"\(status) · n=\(sampleCount)"`. Empty state per row: `"—"`.
   Section-level empty state when *all* states have
   `sampleCount == 0`: `"No status-transition history in last
   N days."`.

States across all sections:
- **Loading:** `ProgressView` per-section skeleton.
- **Empty:** per-section empty copy as above.
- **Error:** red caption banner above sections — same pattern as
  `ReliabilityDrillView`.

### Row-click navigation

The heatmap cell expansion's row-click reuses
`analyticsSelectPodResult(sessionId:)` at `MainView.swift:344-373`
(clears the selected card, switches sidebar to All Pods, opens the
detail panel). Set `requestedDetailTab = .summary` so the pod opens
with Summary focused — matching Phase 3 precedent. There is no
Throughput-specific tab in the pod detail panel and this phase does
not add one.

## Reference reading

- `docs/analytics-dashboard-plan.md` Phase 5 — the seed; this spec
  refines the Throughput half. Escalations is split out to a separate
  `analytics-escalations` spec.
- `specs/analytics-shell/design.md` — `AnalyticsCard` API + right-pane
  scene state contract (consume as-is, do not widen).
- `specs/analytics-cost/design.md` — trailing-window + composite-endpoint
  conventions; respect verbatim.
- `specs/analytics-reliability-funnel/design.md` — terminal cohort
  definition (lines 171-185), aggregator placement, prior-window delta
  pattern, four-section drill layout, `analyticsSelectPodResult`
  navigation precedent.
- `specs/analytics-quality/design.md` — days picker UX, table row-click
  + Summary tab focus, sticky header in drill.
- `specs/analytics-safety/design.md` — recent multi-section drill
  pattern with empty states; cohort-distinguishing convention.
- `packages/shared/src/types/pod.ts:47` — `PodStatus` enum, 16 values.
  The 4 load-bearing states selected here are a strict subset.
- `packages/shared/src/types/events.ts` — `PodStatusChangedEvent`
  shape: `{ podId, previousStatus, newStatus, timestamp }`. Stored in
  the `events` table; `time-in-status` derivation reads
  `events.payload->>'newStatus'` filtered to
  `type = 'pod.status_changed'`.
- `packages/daemon/src/db/migrations/001_initial.sql:42-43` — pod
  timestamp columns: `created_at`, `started_at`, `completed_at`. No
  separate `queued_at` column — pods are at `status='queued'` from
  `created_at` until `started_at`.
- `packages/daemon/src/pods/reliability-aggregator.ts:240-310` —
  prior-window delta math, terminal-cohort sub-query pattern,
  `SQLITE_MAX_VARIABLE_NUMBER` workaround, status-event walking.
  Brief 01 mirrors these patterns.
- `packages/daemon/src/pods/reliability-aggregator.test.ts` — testing
  patterns for cohort fixtures + window math.
- `packages/daemon/src/api/routes/pods.ts:237-277` — Cost / Quality /
  Reliability / Safety registration pattern; copy the validation
  envelope and error shape for the new
  `/pods/analytics/throughput` route.
- `packages/daemon/src/api/routes/pods.test.ts:119-360` — Reliability
  route test pattern (days validation, default behaviour, structural
  assertions); template for throughput-route tests.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/QualityDrillView.swift`
  (Phase 3) — days picker + sectioned scroll + table row click. Drill
  layout pattern.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ReliabilityDrillView.swift`
  — error-banner + per-section loading pattern.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/SafetyDrillView.swift`
  — most-recent multi-section drill; empty-state copy idiom.
- `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift:1048` —
  `DetailTab` enum; `.summary` is the row-click focus target.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:344-373` —
  existing `requestedDetailTab` plumbing + `analyticsSelectPodResult`.
- `packages/desktop/Tests/AutopodClientTests/ReliabilityAnalyticsResponseTests.swift`
  — JSON-decode test scaffolding for the Codable mirror.
- `CLAUDE.md` "CRITICAL — migration numbering" — N/A this phase (no
  migration), but kept in mind: highest existing prefix is `097`.
- 📋 ADR-015 (model pricing as bundled JSON) — analytics-relevant
  baseline.
- 📋 ADR-016 (per-attempt phase token taxonomy) — forward-only data
  convention precedent; throughput's "pre-event-bus pods get zero
  samples" is the same shape.

## Decisions

No new ADRs introduced by this phase. Every load-bearing choice is
mechanical from existing data + Phase 0/1/2 conventions:

- Terminal cohort: identical to Phase 1/2; ADR-equivalent
  decision is "Phase 1 set this; later phases honour it."
- Headline = mean pods/day (= |terminal cohort| / days), not "total
  in window with /Nd caption". Rationale: the user said "pods/day"
  specifically when picking the headline; treat it as a rate rather
  than a sum. Sub-line carries MTTM and live backlog.
- Delta direction threshold: `up` if `value > 0.1`, `down` if
  `value < -0.1`, else `flat`. Reasonable for fleets in the 1–10
  pod/day range; smaller swings register as flat.
- Heatmap timezone: client-side (user-local) bucketing from raw UTC
  ISO timestamps. Travels with the operator; works correctly when
  the dashboard is shared across timezones.
- Box-plot stats: p25/p50/p75 box + p90 whisker + max marker.
  Standard shape, surfaces tail.
- Queue-depth granularity: hourly buckets, max + mean per bucket.
  90-day window = 2 160 buckets — comfortable for a single chart.
- One composite endpoint per card (matches Phases 1/2/3/4; rejected
  alternative was per-section endpoints which would have multiplied
  HTTP calls 3× without latency benefit at this data volume).
- No new persistence: all data already exists in `pods`, `events`.

ADRs reused:
- ADR-015: Model pricing as bundled JSON (analytics-relevant
  baseline).
- ADR-016: Per-attempt phase token taxonomy — forward-only data
  convention; same idea applied to time-in-status (pre-event-bus
  pods contribute no samples).
