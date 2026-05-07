# Design — Analytics Quality Drill-Down

## Blast radius

### Daemon (Brief 02)
- `packages/daemon/src/api/routes/pods.ts` — register
  `GET /pods/analytics/quality`. Validation pattern matches the Reliability
  route at `pods.ts:252`.
- `packages/daemon/src/api/routes/pods.test.ts` — route-level integration
  tests modelled on the Reliability block at `pods.test.ts:119+`.
- `packages/daemon/src/pods/quality-score-repository.ts` — new aggregation
  method (e.g. `getQualityAnalytics(days)`) that returns the composite shape
  in one or two queries.
- `packages/daemon/src/pods/quality-score-repository.test.ts` — coverage for
  the new method.
- `packages/shared/src/types/analytics.ts` — `QualityAnalyticsResponse` type.
- `packages/shared/src/index.ts` — re-export.

### Desktop sidebar (Brief 01)
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift` —
  delete (or shrink to a single `.overview` case if you prefer keeping the
  enum for routing symmetry; deletion is cleaner).
- `packages/desktop/Sources/AutopodUI/Views/Shell/SidebarView.swift` —
  collapse the `Section("Analytics") { ForEach(AnalyticsSection.allCases) … }`
  block (lines 104–109) to a single `sidebarRow(.analytics, …)` row.
  Reintroduce a flat `SidebarItem.analytics` case (replacing
  `analyticsSection(_)`).
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` — drop
  the `if section == .overview / else placeholder` branch (lines 267–287)
  and the `analyticsSelectPodResult`/`analyticsSection` plumbing where it
  switches on a section. The `detail` branch at line 365 still renders
  `AnalyticsRightPaneView` for the analytics sidebar item.
- `packages/desktop/Tests/AutopodClientTests/AnalyticsSectionTests.swift` —
  delete (the enum is gone).
- `packages/desktop/Tests/AutopodClientTests/AnalyticsWiringTests.swift` —
  update assertions that referenced the removed enum or the placeholder.

### Desktop quality drill (Brief 03)
- `packages/desktop/Sources/AutopodClient/Types/QualityAnalyticsResponse.swift`
  (new) — Codable mirror of the TS type.
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` — new
  `getQualityAnalytics(days:)` method, slot in next to
  `getReliabilityAnalytics` (`DaemonAPI.swift:268`).
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` —
  enrich the Quality card (sparkline, delta, "N red pods" sub-line);
  remove the inline `QualityDrillView` struct (extracted to its own file).
- `packages/desktop/Sources/AutopodUI/Views/Analytics/QualityDrillView.swift`
  (new) — band chips + days picker + histogram + reason tiles + filterable
  scores table. Replaces the inline implementation.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`
  — accept a `loadQuality: (() async throws -> QualityAnalyticsResponse)?`
  closure, plumb it into the new `QualityDrillView`.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` — wire
  `loadQualityAnalytics` next to `loadCostAnalytics` /
  `loadReliabilityAnalytics`; on row-click in the drill, route to All Pods
  with `requestedDetailTab = .summary` (existing pattern at
  `MainView.swift:347`).
- `packages/desktop/Tests/AutopodClientTests/QualityAnalyticsResponseTests.swift`
  (new) — JSON decode coverage modelled on
  `ReliabilityAnalyticsResponseTests.swift`.

## Seams

Three seams, three briefs.

1. **Sidebar simplification (Brief 01).** Pure desktop-side delete of the
   sub-row enum + placeholder branch. No data dependency. Independent of
   Brief 02 and 03.
2. **Daemon analytics-quality endpoint (Brief 02).** Owns the
   `QualityAnalyticsResponse` contract. Independent of Brief 01.
3. **Desktop quality drill (Brief 03).** Consumes the contract from Brief 02:
   Codable Swift type, API call, enriched card, new drill view, row-click
   navigation. Depends on `02-add-quality-analytics-endpoint` because the
   Swift type mirrors the TS one and the API method targets the new
   endpoint.

Briefs 01 and 02 may run in parallel; 03 follows 02.

## Contracts

`QualityAnalyticsResponse` is the only cross-pod contract. Brief 02 owns
both the TS source and the API shape. Brief 03 mirrors it in Swift.

```ts
// packages/shared/src/types/analytics.ts (added in Brief 02)
export interface QualityAnalyticsResponse {
  /** High-level totals over the trailing window. */
  summary: {
    totalPodsScored: number;
    avgScore: number;
    redCount: number;     // score < 60
    yellowCount: number;  // 60..79
    greenCount: number;   // 80..100
    deltaVsPrior: { value: number; direction: 'up' | 'down' | 'flat' };
  };
  /** Length always equals `days` from the query. */
  sparkline: Array<{ day: string; avgScore: number; podCount: number }>;
  /** Fixed 10 buckets: 0-9, 10-19, ..., 90-100. Empty buckets have count 0. */
  distribution: Array<{ bucket: string; count: number }>;
  /** Counts of pods that triggered each persisted signal. */
  reasons: {
    lowReadEditRatio: number;       // readEditRatio < 1 AND editCount > 0
    editsWithoutPriorRead: number;  // editsWithoutPriorRead > 0
    userInterrupts: number;         // userInterrupts > 0
    validationFailed: number;       // validationPassed === false
    prFixAttempts: number;          // prFixAttempts > 0
    editChurn: number;              // editChurnCount > 0
    tells: number;                  // tellsCount > 0
  };
  /** Full list of scores in the window — drill table renders from this. */
  scores: PodQualityScore[];
}
```

Validation rules on the daemon side (modelled on
`pods.ts:251-262` Reliability handler):

- `days` defaults to `30`.
- `days < 1` → `400 { error: 'days must be >= 1' }`.
- `days > 365` → `400 { error: 'days must be <= 365' }`.
- Pod filter applied to `scores`: only `final_status IN ('complete','killed')`
  rows where `completed_at` falls in the window. Workspace pods are already
  excluded — `quality-score-recorder.ts` only writes scores for non-workspace
  terminal pods.

The Swift mirror in
`packages/desktop/Sources/AutopodClient/Types/QualityAnalyticsResponse.swift`
must match field-for-field; existing Cost/Reliability response types are
the precedent for snake_case vs camelCase decoding (the daemon uses
camelCase in JSON, no key conversion needed — see
`CostAnalyticsResponse.swift`).

## UX flows

### Sidebar
Single `Analytics` row in the sidebar group. Click → middle pane is
Overview, right pane is "click a card to drill in" empty state. No more
sub-rows. No more "ships in Phase N" placeholder anywhere.

### Overview — Quality card
Same `AnalyticsCard` API as Cost (`AnalyticsView.swift:84-96`):
- **value:** "82" (avg score, rounded)
- **sparkline:** trailing daily-average score points (length = window)
- **delta:** `+2pp` / `-1pp` vs the immediately preceding window — same
  preceding-window math as Cost.
- **sub-line under value:** `"3 red pods"` (only shown when `redCount > 0`).
- **isSelected / onClick:** unchanged from existing pattern.

The card pulls from `loadQuality` (newly threaded through `MainView`).

### Drill view
Header (sticky inside the right-pane scroll):
- **Band chips:** `All` (default), `Red <60`, `Yellow 60–79`, `Green 80+`.
  Filters table + reason tiles. Reason tiles always count *all* pods (so
  the operator can see the absolute reason picture); the Band chip only
  filters which rows the table shows.
  
  Wait — that's confusing. Lock the simple rule: chips filter both. The
  table shows pods in the selected band; the reason tiles show how many of
  those filtered pods triggered each signal.
- **Days picker:** numeric stepper or menu; default 30; values
  `7 / 14 / 30 / 60 / 90`. Re-fetches `/pods/analytics/quality?days=N`.

Body, in scroll order:
1. **Histogram** — 10 buckets (0–9 … 90–100), bar chart, color-coded by
   band threshold. Pure read-only; not interactive in this phase.
2. **Reason breakdown** — 7 counter tiles laid out as a wrap grid:
   `Low read/edit`, `Edits w/o read`, `User interrupts`, `Validation failed`,
   `PR fix attempts`, `Edit churn`, `Tells`. Each tile = signal label + big
   count + caption "of N pods" where N is the filtered total.
3. **Scores table** — same columns as today (Score, Profile, Runtime,
   Model, Cost, Completed, Pod) with band-filter applied. Sortable. Click
   a row → router fires `onSelectPod(podId)` with focus target Summary
   tab.

States:
- **Loading:** `ProgressView`.
- **Empty (window has zero scored pods):** centered `"No completed pods
  scored in the last N days."`.
- **Error:** red caption text under the header — same pattern as
  `QualityDrillView` today (`AnalyticsView.swift:226-233`).

### Row-click navigation
`onSelectPod` in `AnalyticsRightPaneView` already exists. Brief 03 uses
the existing helper `Self.analyticsSelectPodResult(sessionId:)` at
`MainView.swift:373` (which clears the selected card and switches to All
Pods), and additionally sets `requestedDetailTab = .summary` so the pod
opens with the Summary tab focused. Existing precedent at
`MainView.swift:347`.

## Reference reading

- `docs/analytics-dashboard-plan.md` Phase 3 — original brief; this spec
  refines.
- `packages/daemon/src/pods/quality-score-repository.ts` — existing
  list/getTrends helpers; new `getQualityAnalytics(days)` slots in here.
- `packages/daemon/src/pods/quality-signals.ts` — definitive signal
  definitions; do not re-derive.
- `packages/daemon/src/pods/quality-score-recorder.ts:38-72` — confirms
  every signal is persisted on completion (no event-log scan needed).
- `packages/daemon/src/db/migrations/055_pod_quality_scores.sql` +
  `057_quality_score_signals.sql` — the table that fuels everything.
- `packages/daemon/src/api/routes/pods.ts:237-262` — Cost (`:238`) and
  Reliability (`:252`) endpoint pattern; copy the validation envelope and
  error shape.
- `packages/daemon/src/api/routes/pods.test.ts:119-360` — Reliability route
  test pattern (days validation, default behaviour, structural assertions).
- `packages/shared/src/types/analytics.ts` — Cost + Reliability response
  shapes; new Quality type slots in alongside.
- `specs/analytics-shell/design.md` — `AnalyticsCard` API + right-pane
  scene-state contract that this phase consumes (cards stay
  pre-formatted strings; no card API changes).
- `specs/analytics-cost/design.md` — trailing-window + pod-filter +
  composite-endpoint conventions; respect them.
- `specs/analytics-reliability-funnel/design.md` — drill view + sparkline
  + delta-vs-prior precedent.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift:169-365`
  — current `QualityDrillView` to extract and replace.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift:504`
  — `analyticsScoreColor` thresholds; the band chips must use the same
  cutoffs.
- `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift:1048`
  — `DetailTab` enum (Summary is the row-click focus target).
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:344-350`
  — existing `requestedDetailTab` plumbing; reuse rather than re-invent.
- `packages/desktop/Sources/AutopodUI/Views/Detail/SummaryTab.swift:39` —
  `SessionQualityCard` already lives here; no changes needed in this spec.
- `packages/desktop/Tests/AutopodClientTests/CostAnalyticsResponseTests.swift`
  + `ReliabilityAnalyticsResponseTests.swift` — Codable test patterns to
  copy for the new Quality response type.

## Decisions

No new ADRs. All decisions in this spec are reversible:

- **Band chips, not sliders** — UX choice; reversible by adding a slider
  control later.
- **Sub-row enum deleted, not preserved-but-disabled** — the alternative
  (keep the enum, hide rows visually) was considered and rejected as
  duplicate nav. Trivially reversible — the deleted code remains in git
  history if a roadmap menu is wanted later.
- **Summary tab focus on row click** — reversible; if a dedicated Quality
  tab is added in a future phase, that phase changes the focus target.
- **Composite endpoint with no `minScore`/`maxScore` query params** —
  divergence from the master plan. Filtering happens client-side because
  the operator-grade fleet is small. If the fleet grows past ~10k pods
  per window the endpoint can grow query params later; existing callers
  unaffected.
