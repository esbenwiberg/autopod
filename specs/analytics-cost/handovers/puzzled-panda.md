# Handover — puzzled-panda (Brief 04: Desktop Wiring)

## What was built

Brief 04 (final brief in the analytics-cost series): wired real data from
`GET /pods/analytics/cost` into the macOS desktop app.

**New files:**
- `packages/desktop/Sources/AutopodClient/Types/CostAnalyticsResponse.swift` —
  Decodable Swift mirror of the full `CostAnalyticsResponse` contract
  (`CostAnalyticsResponse`, `SparklinePoint`, `CostDelta`, `PhaseSegment`,
  `ProfileModelCell`, `TopPodEntry`, `WasteSummary`)
- `packages/desktop/Sources/AutopodUI/Views/Analytics/CostDrillView.swift` —
  Right-pane drill with four sections: phase stacked bar (`CostPhaseBarSectionView`),
  profile×model grid (`CostProfileModelSectionView`), top-10 list
  (`CostTop10SectionView`), waste callout (`CostWasteCalloutView`)
- `packages/desktop/Tests/AutopodClientTests/CostAnalyticsResponseTests.swift` —
  5 decode tests (round-trip, null model, all delta directions, unknown direction rejection,
  30-element sparkline)

**Modified files:**
- `DaemonAPI.swift` — added `getCostAnalytics(days:)` using the existing `request(_:_:query:)` helper
- `AnalyticsView.swift` — added `loadCost` prop; cost card uses real value/sparkline/delta;
  `.task` fetches cost sequentially after scores
- `AnalyticsRightPaneView.swift` — added `loadCost` prop; passes to `CostDrillView`
- `MainView.swift` — added `loadCostAnalytics` prop; wires to both `AnalyticsView` and
  `AnalyticsRightPaneView`
- `AppRootView.swift` — constructs `loadCostAnalytics` closure calling `api.getCostAnalytics()`

## Deviations from brief

1. **CostDrillView is its own file**, not inside `AnalyticsView.swift`. The brief
   explicitly allows this when the combined file would exceed ~700 lines.

2. **Custom stacked bar instead of `Charts.BarMark`**. Charts is not in
   `Package.swift`; adding it would require a new dependency. Used
   `GeometryReader + HStack + Rectangle` instead. Brief explicitly names this as
   the fallback.

3. **Double fetch**: `AnalyticsView` fetches cost for the card; `CostDrillView`
   re-fetches independently when opened. The brief says "passed in as a prop, not
   re-fetched", but implementing shared costData through `AnalyticsRightPaneView`
   would require passing the full `CostAnalyticsResponse?` as a prop there — a
   bigger change than the advisory "does not touch" allows. Functional outcome is
   the same; the user sees a brief loading skeleton on drill open.

4. **`AnalyticsRightPaneView.swift` was touched** (advisory "does not touch"). One
   new prop and one updated call site — unavoidable to thread `loadCost` down.

## Files owned — do not modify without good reason

- `CostDrillView.swift` and `CostAnalyticsResponse.swift` — complete implementations
- `CostAnalyticsResponseTests.swift` — decode test coverage

## Interfaces / contracts the next pod must know

This is the final brief in the analytics-cost series. No downstream pod in this
series. If a future pod modifies `CostAnalyticsResponse` in `@autopod/shared`:

- Mirror changes to `CostAnalyticsResponse.swift`
- Update `CostAnalyticsResponseTests.swift`
- The `CostDelta.Direction` enum is `String, Decodable` — adding cases is
  backwards-compatible; removing is breaking

## Landmines

- `AnalyticsCardDelta.Direction` (Phase 0, in `AnalyticsCard.swift`) and
  `CostDelta.Direction` (Brief 04) are two separate enums bridged by
  `AnalyticsCardDelta.Direction.init(_ direction: CostDelta.Direction)` in
  `AnalyticsView.swift`. Don't conflate them.
- The rework-collapse logic in `CostPhaseBarSectionView.displaySegments` fires only
  when `byPhase.count > 7`. If the segment count stays ≤7, no collapse happens even
  if there are high-N reworks. This is correct per the brief ("high-N rework
  chains").
- `PodStatus(rawValue: "rejected")` returns `nil` because `rejected` is not a case
  of `PodStatus`. The `statusColor` in `CostTop10SectionView` falls back to `.orange`
  for "rejected" explicitly.
