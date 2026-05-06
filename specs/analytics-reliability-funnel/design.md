# Design — Reliability funnel + stage failure analytics

## Blast radius

**Daemon** (~5 files):
- `packages/daemon/src/api/routes/pods.ts` — register `GET
  /pods/analytics/reliability`. Mirror the Phase 1 cost-endpoint
  registration pattern; do not refactor adjacent routes.
- `packages/daemon/src/analytics/reliability-aggregator.ts` (new) —
  pure aggregation function from raw query rows to
  `ReliabilityAnalyticsResponse`. Co-located test file.
- `packages/daemon/src/analytics/reliability-aggregator.test.ts`
  (new) — unit tests for funnel band derivation, drop reason
  classification, stage failure roll-up, profile heatmap, first-pass
  rate calculation.
- `packages/daemon/src/api/routes/pods.test.ts` — extend to cover
  the new endpoint.

(If a `src/analytics/` directory does not yet exist, create it; if
Phase 1 placed its cost-aggregator elsewhere — e.g. inside
`pods.ts` or under `src/pods/` — match Phase 1's location instead
to avoid splitting the analytics surface across two folders. Read
Phase 1's actual placement at the start of Brief 1.)

**Desktop** (~6 files):
- `packages/desktop/Sources/AutopodClient/Types/ReliabilityAnalyticsResponse.swift`
  (new) — Swift mirror of the contract.
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` —
  `getReliabilityAnalytics(days:)` method, adjacent to
  `getCostAnalytics`.
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift`
  — extend enum with `.reliability`.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`
  — add `.reliability` switch case routing to the drill.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift`
  — Reliability card data wiring + four drill section views as
  private structs.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift`
  — one-line addition: `loadReliability:
  daemonAPI.getReliabilityAnalytics(days: 30)` parameter on the
  existing `AnalyticsView(...)` call site.

## Seams

There is exactly one seam: the REST contract
`GET /pods/analytics/reliability` between daemon and desktop. Brief 1
owns the daemon side and freezes the response shape; Brief 2 consumes
the contract verbatim on the desktop.

## Contracts

The endpoint returns one composite payload per click. Sparkline lives
on the same response — no per-card-section sub-endpoints (matches
Phase 1 convention).

```ts
// Trailing-window query params: ?days=30 (default).
// All counts/rates apply to the terminal cohort:
//   output_mode != 'workspace'
//   AND status IN ('complete', 'killed', 'failed')
//   AND completed_at >= datetime('now', '-' || @days || ' days')

export type FunnelBand =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'validating'
  | 'validated'
  | 'approved'
  | 'merging'
  | 'complete';

export type FinalStatus = 'complete' | 'killed' | 'failed';

export type ValidationStage =
  | 'build'
  | 'health'
  | 'smoke'
  | 'test'
  | 'lint'
  | 'sast'
  | 'acValidation'
  | 'taskReview';

export interface ReliabilityAnalyticsResponse {
  /** First-pass rate over the trailing window: 0..1.
   *  Numerator: pods with status='complete' AND reworkCount=0.
   *  Denominator: |terminal cohort|. Returns 0 when cohort is empty. */
  firstPassRate: number;

  /** One entry per day in window. rate is 0..1; days with zero
   *  terminal pods emit rate=0. Length == days. */
  firstPassRateSparkline: Array<{ day: string; rate: number }>;

  /** Direction is 'up' when current > prior by >0.5 percentage
   *  points, 'down' when <-0.5pp, 'flat' otherwise. */
  firstPassRateDelta: {
    value: number;                                // signed pp diff
    direction: 'up' | 'down' | 'flat';
  };

  funnel: {
    /** Always 8 entries, in band order. count = pods that *ever
     *  reached* this band according to events.payload.newStatus.
     *  Pods that started inside the window count even if they
     *  passed through `queued` before. */
    bands: Array<{ band: FunnelBand; count: number }>;

    /** Drops aggregated by (from-band, finalStatus). One drop entry
     *  per (from, to) where `to ∈ {killed, failed}` OR
     *  `to === 'complete'` is omitted (success is not a drop).
     *  Bands a pod skipped (e.g. recovered pods) do not contribute
     *  drops; only the *last band reached* counts. */
    drops: Array<{
      from: FunnelBand;
      to: FinalStatus;          // killed | failed; 'complete' never appears here
      count: number;
      /** Up to 10 example pods, ordered by completedAt DESC. */
      topPods: Array<{
        podId: string;
        profile: string;
        finalStatus: FinalStatus;
        completedAt: string;    // ISO
      }>;
      /** Number of pods beyond the topPods cap; 0 when count <= 10. */
      overflow: number;
    }>;
  };

  /** Per-stage roll-up over terminal cohort.
   *  podsRan = pods whose validations.result.<stage> is non-null
   *            (any attempt). Pods that never reached `validating`
   *            are excluded from podsRan.
   *  podsFailed = pods with at least one attempt where
   *               result.<stage>.status === 'fail' OR overall === 'fail'
   *               attributable to that stage.
   *  failureRate = podsFailed / podsRan, or 0 when podsRan === 0. */
  stageFailures: Array<{
    stage: ValidationStage;
    podsRan: number;
    podsFailed: number;
    failureRate: number;
  }>;

  /** Heatmap rows are profiles; columns are stages. Profiles with
   *  zero pods in cohort are excluded. Stage entries omit stages the
   *  profile never ran. Cell rate = podsFailed / podsRan. */
  profileHeatmap: Array<{
    profile: string;
    stages: Array<{
      stage: ValidationStage;
      podsRan: number;
      podsFailed: number;
      failureRate: number;
    }>;
  }>;

  summary: {
    /** Stage with highest failureRate (ties: highest podsFailed
     *  wins; further ties: alphabetical). Empty string when no
     *  stage has any failures. */
    topFailureStage: ValidationStage | '';
    /** Mean rework_count across cohort pods. */
    avgReworkCount: number;
    /** |terminal cohort|. Useful for "no data" UX state. */
    totalPodsInWindow: number;
  };
}
```

### Filter / cohort semantics (non-negotiable, mirror Phase 1)

The terminal cohort filter applies to *every section* of the
response. Restating verbatim from Phase 1 design.md to avoid drift:

- `pod.outputMode != 'workspace'` (worker pods only). Stored column
  is `output_mode`; SQL uses `output_mode != 'workspace'`.
- `pod.status IN ('complete', 'killed', 'failed')`.
- `pod.completed_at >= datetime('now', '-' || @days || ' days')`.

Phase 1's design refers to `isWorkspace == false` as a virtual
predicate. There is no `isWorkspace` column — Phase 2 uses the
literal `output_mode != 'workspace'` SQL clause. Keep the predicate
in one helper (`buildTerminalCohortClause(days)`) reused across
queries.

A note on the historical `'rejected'` literal: it appears in
`packages/shared/src/types/analytics.ts:22` as a derived label, not
a real PodStatus value. Phase 1's brief listed it in a status filter
where it can never match (harmless dead code). Phase 2 omits it
entirely — `complete | killed | failed` is the closed set.

## UX flows

**Overview card.**
Reliability card sits adjacent to Cost / Quality / Status on the
analytics overview grid. Loading: skeleton. Loaded: value =
`String(format: "%.0f%%", firstPassRate * 100)`; sparkline =
`firstPassRateSparkline.map(\.rate)`; delta uses the existing
`AnalyticsCardDelta` shape (`value` formatted as `±X.Xpp`,
`direction` mapped from `firstPassRateDelta.direction`). Empty
cohort: value = `"—"`, sparkline = nil, delta = nil.

**Click → drill.**
`AnalyticsRightPaneView` switch gains a `.reliability` case routing
to `ReliabilityDrillView`. Drill is a single `ScrollView` with four
sections in order:

1. **`ReliabilityFunnelSectionView`** — happy-path funnel rendered
   with a custom SwiftUI `Path` (8 horizontal bands stacked
   vertically; band width proportional to `count / max(counts)`).
   Drop arrows annotate the right side of each band, labeled with
   `from → to (count)`. Tapping a drop arrow expands an inline
   `DisclosureGroup` listing `topPods` (each row clickable → fires
   `onSelectPod` callback, plumbed identically to Phase 1).
   Overflow indicator: `+ N more` when `overflow > 0`. Empty
   state: "No terminal pods in window."

2. **`ReliabilityStageFailureSectionView`** — `Charts.BarMark`
   horizontal bar chart, one bar per stage sorted by
   `failureRate` DESC. Bar value = `failureRate`; secondary label
   shows `"\(podsFailed)/\(podsRan) pods"`. Empty state: "No
   validation data."

3. **`ReliabilityProfileHeatmapSectionView`** — `LazyVGrid` with
   profile rows × stage columns. Cell color is a
   `Color.red.opacity(failureRate)` overlay on a neutral
   background; cell text shows `"\(Int(failureRate * 100))%"` and
   `"\(podsFailed)/\(podsRan)"` below in `.secondary`. Stages a
   profile never ran render as `—`. Horizontal scroll when stage
   count exceeds visible width. Empty state: "No profile data."

4. **`ReliabilitySummaryCalloutView`** — single styled card
   matching the Phase 1 `CostWasteCalloutView` material shell but
   non-clickable. Title `"Top failure stage"`, big text =
   `summary.topFailureStage` capitalized, subtitle = `"\(Int(avgReworkCount * 100) / 100) avg reworks across \(totalPodsInWindow) pods"`.

All four section views render only the relevant slice of the
response; loading shows skeleton placeholders; an inline error
banner sits above the sections on fetch failure.

Implement the four sections as `private struct` declarations inside
`AnalyticsView.swift` (mirrors Phase 1's `Cost*SectionView` pattern).
If the file exceeds ~700 lines after this brief, split — but don't
pre-emptively factor.

**Toggle-off and pod selection** are Phase 0 plumbing; reused
unchanged. Clicking the Reliability card again closes the drill.
Clicking a top-pod row in a drop expansion clears
`selectedAnalyticsCard` and switches the sidebar to "All Pods" with
the chosen pod selected (via the existing
`analyticsSelectPodResult(sessionId:)` helper).

## Reference reading

- `packages/shared/src/types/pod.ts:47` — `PodStatus` enum, 16 values.
  The 8 happy-path bands plus the 8 side-tracks (`awaiting_input`,
  `paused`, `handoff`, `review_required`, `merge_pending`, `failed`,
  `killing`, `killed`) are jointly exhaustive.
- `packages/shared/src/types/events.ts:56` — `PodStatusChangedEvent`
  shape: `{ podId, previousStatus, newStatus, timestamp }`. Stored
  in the `events` table; the funnel query reads
  `events.payload->>'newStatus'` filtered to `type =
  'pod.status_changed'`.
- `packages/shared/src/types/validation.ts` — `ValidationResult`
  shape: smoke (containing build, health, pages), test, lint, sast,
  acValidation, taskReview, overall. Stage names in
  `stageFailures` MUST match the JSON keys.
- `packages/daemon/src/pods/validation-repository.ts` —
  `StoredValidation` with `attempt` field. The query reads from the
  `validations` table and joins on `pod_id`. Multiple rows per pod
  (one per attempt) — collapse to per-pod ever-failed in the
  aggregator.
- `packages/daemon/src/validation/local-validation-engine.ts` —
  the `onPhaseCompleted` callbacks confirm the 8 stage names. Do
  not invent new stages; if a future stage is added, the
  aggregator falls through (`stages.push({ stage, podsRan: 0,
  podsFailed: 0, failureRate: 0 })` is wrong — instead, surface it
  in `stageFailures` once any pod actually ran it).
- `packages/daemon/src/db/migrations/072_pod_rework_count.sql` —
  `pods.rework_count` is the first-pass discriminator. Increments
  on each retry within the validation feedback loop. `0` means
  "no rework needed."
- `specs/analytics-cost/design.md:200-220` — Phase 1's terminal
  cohort filter section. Reuse the SQL clause verbatim; ditto the
  trailing-window param convention (`?days=30` default).
- `specs/analytics-cost/briefs/03-add-cost-analytics-endpoint.md` —
  Phase 1's daemon endpoint brief. Brief 1 mirrors the same
  registration pattern, helper layout, and test scaffolding.
- `specs/analytics-cost/briefs/04-wire-desktop-cost-drill.md` —
  Phase 1's desktop wiring brief. Brief 2 mirrors the Swift type
  shape, `DaemonAPI` method placement, four-section drill layout,
  and `MainView` one-line wiring pattern.
- `specs/analytics-shell/design.md` — Phase 0 contracts:
  `AnalyticsCard` API (do not widen), `AnalyticsCardKind` exhaustive
  switch, `AnalyticsRightPaneView` routing pattern, sidebar sub-row
  semantics. Reliability extends `AnalyticsCardKind` by exactly one
  case (`.reliability`); the existing exhaustive-switch sites
  enforce coverage.
- `specs/analytics-shell/handovers/continued-cat.md:50` —
  `toggleAnalyticsCard` and `analyticsSelectPodResult` helpers.
  Reused unchanged.

## Decisions

No new ADRs. Every load-bearing choice is mechanical from existing
data + Phase 0/1 conventions:

- Funnel band set is the closed 8-state happy path. PodStatus enum
  pins this.
- Cohort is identical to Phase 1 (terminal pods, trailing window).
  ADR-equivalent decision is "Phase 1 set this; Phase 2 honors it."
- Stage taxonomy is the 8 keys already in `ValidationResult`.
- First-pass = `complete && reworkCount === 0`. The `rework_count`
  column was added for exactly this kind of question (see migration
  072).
- One composite endpoint per card (matches Phase 1; rejected
  alternative was per-section endpoints which would have multiplied
  HTTP calls 4× without latency benefit at this data volume).
