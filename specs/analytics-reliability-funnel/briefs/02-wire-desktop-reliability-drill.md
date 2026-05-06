---
title: "Wire desktop Reliability card and ReliabilityDrillView"
depends_on: [01-add-reliability-endpoint]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodClient/Types/ReliabilityAnalyticsResponse.swift
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
does_not_touch:
  - packages/desktop/Sources/AutopodUI/Views/Shell/SidebarView.swift
  - packages/daemon/
---

## Task

Wire the daemon's `GET /pods/analytics/reliability` endpoint into a
Reliability card on the Overview analytics page and a four-section
drill in `AnalyticsRightPaneView`. This is the brief that delivers
the user-visible outcome.

### `ReliabilityAnalyticsResponse` Swift mirror

Create
`packages/desktop/Sources/AutopodClient/Types/ReliabilityAnalyticsResponse.swift`.
Decodable struct hierarchy mirroring `design.md` → Contracts:

```swift
public struct ReliabilityAnalyticsResponse: Decodable, Equatable {
    public let firstPassRate: Double
    public let firstPassRateSparkline: [SparklineRatePoint]
    public let firstPassRateDelta: ReliabilityDelta
    public let funnel: ReliabilityFunnel
    public let stageFailures: [StageFailureRow]
    public let profileHeatmap: [ProfileHeatmapRow]
    public let summary: ReliabilitySummary
}

public struct SparklineRatePoint: Decodable, Equatable {
    public let day: String   // "YYYY-MM-DD"
    public let rate: Double
}

public struct ReliabilityDelta: Decodable, Equatable {
    public let value: Double
    public let direction: Direction
    public enum Direction: String, Decodable { case up, down, flat }
}

public struct ReliabilityFunnel: Decodable, Equatable {
    public let bands: [BandCount]
    public let drops: [DropEntry]
}

public struct BandCount: Decodable, Equatable {
    public let band: FunnelBand
    public let count: Int
}

public enum FunnelBand: String, Decodable, CaseIterable {
    case queued, provisioning, running, validating
    case validated, approved, merging, complete
}

public enum FinalStatus: String, Decodable {
    case complete, killed, failed
}

public struct DropEntry: Decodable, Equatable {
    public let from: FunnelBand
    public let to: FinalStatus
    public let count: Int
    public let topPods: [DropPodEntry]
    public let overflow: Int
}

public struct DropPodEntry: Decodable, Equatable {
    public let podId: String
    public let profile: String
    public let finalStatus: FinalStatus
    public let completedAt: String   // ISO
}

public enum ValidationStage: String, Decodable, CaseIterable {
    case build, health, smoke, test, lint, sast, acValidation, taskReview
}

public struct StageFailureRow: Decodable, Equatable {
    public let stage: ValidationStage
    public let podsRan: Int
    public let podsFailed: Int
    public let failureRate: Double
}

public struct ProfileHeatmapRow: Decodable, Equatable {
    public let profile: String
    public let stages: [StageFailureRow]
}

public struct ReliabilitySummary: Decodable, Equatable {
    /// Empty string when no failures observed; decode as `.none`.
    public let topFailureStage: ValidationStage?
    public let avgReworkCount: Double
    public let totalPodsInWindow: Int

    enum CodingKeys: String, CodingKey {
        case topFailureStage, avgReworkCount, totalPodsInWindow
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try c.decode(String.self, forKey: .topFailureStage)
        self.topFailureStage = raw.isEmpty ? nil : ValidationStage(rawValue: raw)
        self.avgReworkCount = try c.decode(Double.self, forKey: .avgReworkCount)
        self.totalPodsInWindow = try c.decode(Int.self, forKey: .totalPodsInWindow)
    }
}
```

### `DaemonAPI` method

Add to `packages/desktop/Sources/AutopodClient/DaemonAPI.swift`,
adjacent to `getCostAnalytics`:

```swift
public func getReliabilityAnalytics(days: Int = 30) async throws -> ReliabilityAnalyticsResponse {
    try await get("/pods/analytics/reliability?days=\(days)")
}
```

### `AnalyticsCardKind` extension

In
`packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift`,
add one case: `.reliability`. Phase 0 made the enum exhaustive
across the codebase — the compiler will surface every site that
needs an explicit handler. Add cases at all those sites:

- `AnalyticsRightPaneView.swift` switch — route to
  `ReliabilityDrillView`.
- `analyticsSelectPodResult` helper (if it switches on the kind)
  — match Phase 1's `.cost` handling.
- `toggleAnalyticsCard` — no change; it's generic over the enum.

### Reliability card data wiring

In `AnalyticsView.swift`, mirror the Phase 1 `Cost` card pattern:

1. `@State private var reliabilityData: ReliabilityAnalyticsResponse? = nil`,
   `@State private var reliabilityLoadError: String? = nil`,
   `@State private var isLoadingReliability: Bool = false`.
2. Add `loadReliability: (() async throws ->
   ReliabilityAnalyticsResponse)?` prop, same shape as `loadCost`.
   Caller (`MainView`) wires it to
   `daemonAPI.getReliabilityAnalytics(days: 30)`.
3. In `.task`, call `loadReliability` once and populate
   `reliabilityData`. On error, set `reliabilityLoadError`.
4. Card props: when `reliabilityData != nil`, set
   `value` to `String(format: "%.0f%%", data.firstPassRate * 100)`,
   `sparkline` to `data.firstPassRateSparkline.map(\.rate)`,
   `delta` to `AnalyticsCardDelta(value: String(format: "%+.1fpp",
   data.firstPassRateDelta.value), direction:
   .init(data.firstPassRateDelta.direction))`.
   When `nil` (loading or error): `value = "—"`, sparkline + delta
   `nil`.

### `ReliabilityDrillView` body

Add a private `ReliabilityDrillView` struct inside
`AnalyticsView.swift`, matching the structural pattern of
`CostDrillView` from Phase 1. Body is a single `ScrollView`
containing four `private struct` section views:

1. **`ReliabilityFunnelSectionView`** — custom SwiftUI `Path`
   rendering 8 horizontal bands stacked vertically. Band width =
   `geometry.size.width * (count / maxCount)`, where `maxCount =
   funnel.bands.map(\.count).max() ?? 1`. Each band rendered as a
   `RoundedRectangle` with a label `"\(band.rawValue) (\(count))"`.

   Drop arrows: for each `drop` where `drop.from == band`, render
   a `Triangle` shape on the band's right edge with label
   `"→ \(drop.to.rawValue) (\(drop.count))"`. Arrow color: red for
   `failed`, gray for `killed`.

   Tapping an arrow toggles a `DisclosureGroup` below the band
   listing the drop's `topPods` as clickable rows. Each row:
   `HStack` with `String(podId.prefix(8))`, `profile`, status
   badge, `completedAt` formatted relative. On tap: fire
   `onSelectPod(podId)` (plumbed from Phase 0). When
   `drop.overflow > 0`, render `"+ \(overflow) more"` at the
   bottom of the disclosure.

   Empty state (`bands.allSatisfy { $0.count == 0 }`): "No
   terminal pods in window."

2. **`ReliabilityStageFailureSectionView`** — `Charts.BarMark`
   horizontal chart. One mark per stage in `stageFailures`,
   sorted by `failureRate` DESC. `BarMark(x: .value("Failure
   rate", row.failureRate), y: .value("Stage", row.stage.rawValue))`.
   Annotation on each bar: `"\(row.podsFailed)/\(row.podsRan)"`.
   Bar color: red. Empty state (`stageFailures.allSatisfy {
   $0.podsRan == 0 }`): "No validation data."

3. **`ReliabilityProfileHeatmapSectionView`** — `LazyVGrid` with
   `[GridItem(.fixed(160))]` for the profile column and
   `GridItem(.flexible(minimum: 60), spacing: 4)` × 8 for
   stages. Header row: stage names (rotated 45° if cramped). Body
   rows: profile name, then per-stage cells.

   Cell renderer: if the profile's `stages` contains the stage,
   render a `Color.red.opacity(min(failureRate * 1.2, 1.0))`
   background with `"\(Int(failureRate * 100))%"` text and
   `"\(podsFailed)/\(podsRan)"` `.secondary` subtitle. If not
   present, render `"—"` on a neutral background.

   Horizontal scroll when needed. Empty state
   (`profileHeatmap.isEmpty`): "No profile data."

4. **`ReliabilitySummaryCalloutView`** — single styled card.
   Title `"Top failure stage"`, big text =
   `summary.topFailureStage?.rawValue.capitalized ?? "All clear"`,
   subtitle = `"\(formatRework(summary.avgReworkCount)) avg
   reworks across \(summary.totalPodsInWindow) pods"`. Visual
   shell echoes Phase 1's `CostWasteCalloutView`. Non-clickable.

All four sections take `data: ReliabilityAnalyticsResponse` as
input. Loading: skeleton placeholders. Error: inline error banner
above the sections.

If `AnalyticsView.swift` exceeds ~700 lines after this brief,
factor each `Reliability*SectionView` (and the matching
`Cost*SectionView`s if Phase 1 left them inline) into their own
files. Do not pre-emptively factor.

### `AnalyticsRightPaneView` switch

Add the `.reliability` case:

```swift
case .reliability:
    if let data = reliabilityData {
        ReliabilityDrillView(data: data, onSelectPod: onSelectPod)
    } else if let err = reliabilityLoadError {
        InlineErrorBanner(message: err)
    } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    }
```

The data + error + loading state must be threaded through the
right-pane view if it isn't already. Phase 1 plumbed `costData` /
`costLoadError` into the right pane via constructor params; mirror
that pattern.

### `MainView.swift` wiring (one-liner)

Add `loadReliability:
daemonAPI.getReliabilityAnalytics(days: 30)` to the existing
`AnalyticsView(...)` call site. Same pattern Phase 0 established
for `loadScores` and Phase 1 established for `loadCost`.

NOTE on `does_not_touch`: Phase 1's brief 04 attempted to leave
`MainView.swift` in `does_not_touch` and then added it. Phase 2
states upfront: `MainView.swift` IS in `touches` because the
single-line addition is unavoidable.

## Touches

- `packages/desktop/Sources/AutopodClient/Types/ReliabilityAnalyticsResponse.swift` (new)
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` (new method)
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift` (one case)
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift` (one switch case)
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` (Reliability card + drill + 4 section views)
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` (one parameter addition)

## Does not touch

- `Views/Shell/SidebarView.swift` — Reliability sub-row stays
  disabled (per `purpose.md` → Non-goals).
- `Models/AnalyticsSection.swift`, `Views/Analytics/AnalyticsCard.swift` —
  Phase 0 contracts; consume unchanged.
- `packages/daemon/` — Brief 01 finished the daemon side.

## Constraints

From Phase 0's `AnalyticsCard` API: `value: String, sparkline:
[Double]?, delta: AnalyticsCardDelta?, isSelected: Bool, onClick:
() -> Void`. Don't widen the API; pass strings already formatted.

From `design.md` → UX flows: card is non-interactive (shows `"—"`)
when `reliabilityData` is nil; drill renders skeletons during
load; top-pod click clears the selected card and switches sidebar
(Phase 0 plumbing).

From `purpose.md` → Non-goals: dedicated sidebar Reliability
section stays disabled.

## Test expectations

Add `Tests/AutopodClientTests/ReliabilityAnalyticsResponseTests.swift`:

- Decoding round-trip: feed a JSON fixture matching the contract,
  decode to `ReliabilityAnalyticsResponse`, confirm all fields
  match.
- `topFailureStage: ""` decodes to `nil`.
- `topFailureStage: "test"` decodes to `.test`.
- `FunnelBand` decodes all 8 cases; rejects unknown strings.
- `ValidationStage` decodes all 8 cases; rejects unknown strings.
- `FinalStatus` decodes `complete | killed | failed`; rejects
  others.
- `firstPassRateSparkline` decodes a 30-element array.
- A drop with `overflow: 5` decodes correctly.

These tests do NOT run in the autopod validation pipeline. They
run when the user invokes `swift test` locally on the desktop
package.

## Risks / pitfalls

- **Custom `Path` for funnel** — SwiftUI's `Path` requires manual
  geometry. Bands render in a `GeometryReader`. The temptation to
  use `Charts.BarMark` for the funnel is wrong: stacked horizontal
  bars sized by count look like a bar chart, not a funnel. The
  band-stacks-with-arrows visual REQUIRES custom drawing.

- **Drop arrow hit testing** — making a `Triangle` tappable in
  SwiftUI needs `.contentShape(Rectangle())` to expand the hit
  area, otherwise only the visible triangle pixels respond to
  taps. Test on the smallest expected band size.

- **Heatmap column width with 8 stages** — at full width the
  heatmap fits; at narrow window widths it overflows.
  `ScrollView(.horizontal)` wrapping the grid is the easy fix.
  Don't try to dynamically hide stage columns — every column is
  load-bearing.

- **Empty state vs. zero state** — `firstPassRate: 0` is
  meaningfully different from "no data" (the latter is
  `summary.totalPodsInWindow === 0`). Card renders `"—"` only on
  the latter. Sparkline on zero-data day is fine as a flat line at
  rate 0.

- **`AnalyticsCardKind` exhaustive switches** — adding the
  `.reliability` case will trigger compiler errors at every site
  that switches on the enum. The Phase 0 `continued-cat.md`
  handover noted this is intentional. Read each site, don't
  blanket-add `default:` cases.

- **Status badge colors** — reuse the existing
  `StatusBadge`/`PodCardFinal.swift` mapping. Phase 1 noted this;
  same applies. `failed` → red, `killed` → gray, `complete` →
  green.

- **Date string parsing in sparkline** — `day` is `"YYYY-MM-DD"`.
  Don't parse to `Date` for chart axis; use index for axis labels
  and tooltip-only date string display.

- **`AnalyticsView.swift` size** — Phase 1 already added
  `CostDrillView` + 4 section views; Phase 2 doubles that. The
  ~700-line threshold is likely exceeded. Factor *both* the Cost
  and Reliability section views into separate files, in this
  order: factor first, then add Reliability. Do not pre-emptively
  factor before measuring.

## Wrap-up

1. Run `/simplify` and address findings.
2. `swift build` (or open `Autopod.xcodeproj` and build) to verify
   no Swift type errors. `swift test` to verify
   `ReliabilityAnalyticsResponseTests` pass.
3. **Manual verification:**
   - Start the daemon (with at least a few terminal pods in the
     DB across the last 30 days, including one killed/failed pod
     and one with a stage validation failure).
   - Open the desktop app → Analytics > Overview → Reliability
     card shows non-`"—"` percentage value, sparkline shape, and
     a delta indicator.
   - Click the Reliability card → drill renders all four sections
     in order: funnel, stage failures, profile heatmap, summary
     callout.
   - Tap a drop arrow in the funnel → top-10 list expands inline.
   - Click a top-pod row → sidebar switches to All Pods, that pod
     selected.
   - Click the Reliability card again → drill closes (Phase 0
     toggle-off).
   - Verify the heatmap columns scroll horizontally at narrow
     window widths.
   - Verify the Reliability sub-row in the sidebar is still
     disabled.
4. Commit and push.
