# Handover — rural-sheep (Brief 03: Desktop Quality Drill View)

## What was built

Lit up the Quality analytics drill in the macOS desktop app. The Quality card on
Analytics → Overview is now fully enriched, and clicking it opens a real drill view.

### Files created
- **`packages/desktop/Sources/AutopodClient/Types/QualityAnalyticsResponse.swift`** —
  Codable mirror of the TS `QualityAnalyticsResponse` contract from Brief 02.
  Nested types: `QualityAnalyticsSummary`, `QualityDelta`, `QualitySparklinePoint`,
  `QualityDistributionBucket`, `QualityReasons`. Reuses `PodQualityScore` for `scores`.
- **`packages/desktop/Sources/AutopodUI/Views/Analytics/QualityDrillView.swift`** —
  Full drill view with `QualityBand` enum, band chips, days picker (7/14/30/60/90),
  10-bucket histogram (Swift Charts), 7 reason tiles (band-filtered, single pass),
  and a sortable `Table` of `PodQualityScore` rows. Row click → `onSelectPod`.
- **`packages/desktop/Tests/AutopodClientTests/QualityAnalyticsResponseTests.swift`** —
  9 tests covering all 7 required decode assertions plus empty-fleet + PodQualityScore cases.

### Files modified
- **`packages/desktop/Sources/AutopodClient/DaemonAPI.swift`** — added
  `getQualityAnalytics(days: Int = 30) async throws -> QualityAnalyticsResponse`.
- **`packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsCard.swift`** — added
  optional `subline: String?` parameter (backwards-compatible; Cost/Reliability pass nil).
- **`packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift`** — removed
  old inline `QualityDrillView` struct; added `loadQualityAnalytics` prop + state;
  enriched Quality card with sparkline/delta/subline; made `analyticsScoreColor`
  non-private (was needed by the new standalone `QualityDrillView.swift`).
- **`packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`** —
  added `loadQuality: ((Int) async throws -> QualityAnalyticsResponse)?` parameter;
  routes `.quality` card to new `QualityDrillView`.
- **`packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift`** — added
  `loadQualityAnalytics: ((Int) async throws -> QualityAnalyticsResponse)?` property;
  threaded to `AnalyticsView` and `AnalyticsRightPaneView`; added
  `requestedDetailTab = .summary` to the analytics `onSelectPod` handler.
- **`packages/desktop/Sources/AutopodDesktop/Views/AppRootView.swift`** — wired
  `loadQualityAnalytics` to `api.getQualityAnalytics(days:)`.

## Contracts changed / downstream must know

- `AnalyticsCard` now accepts an optional `subline: String?` parameter (backwards-compat).
- `analyticsScoreColor(_:)` in `AnalyticsView.swift` is now `internal` (was `private`).
  Any future file in the `AutopodUI` module can use it.
- `AnalyticsRightPaneView.init` has a new `loadQuality` parameter. All existing call sites
  were updated (only `MainView.swift` calls it).
- `MainView` has a new optional `loadQualityAnalytics` parameter. Call sites must be updated
  if they instantiate `MainView` with all parameters explicitly (preview scaffolds, tests).

## Files the next pod should NOT modify without good reason

- `Sources/AutopodClient/Types/QualityAnalyticsResponse.swift` — mirrors the locked
  TS contract from Brief 02. Any shape change must coordinate with the daemon.
- `Sources/AutopodUI/Views/Analytics/QualityDrillView.swift` — the new drill view.
- `Tests/AutopodClientTests/QualityAnalyticsResponseTests.swift` — Codable coverage.

## Discovered constraints / landmines

- `analyticsScoreColor` must remain non-private in `AnalyticsView.swift`. The new
  `QualityDrillView.swift` (same module, different file) depends on it. If it's ever
  moved to a shared file, both drill views should import from that location.
- The `loadQualityAnalytics` closure takes `Int` (days) because the drill view has a
  days picker. `loadCostAnalytics` and `loadReliabilityAnalytics` take no parameters
  (those drills have no days picker). Keep this asymmetry in mind if Cost/Reliability
  ever add a days picker.
- The `websocket.test.ts > replayEvents > yields between pages` test is a pre-existing
  flaky timing test. It failed once during the build check but passed on re-run. Not
  related to Brief 03 changes.
