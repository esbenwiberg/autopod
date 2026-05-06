---
title: "Wire desktop Cost card and CostDrillView with real data"
depends_on: [03-add-cost-analytics-endpoint]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodClient/Types/CostAnalyticsResponse.swift
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
does_not_touch:
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsCard.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/SidebarView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
  - packages/daemon/
---

## Task

Replace the placeholder Cost-card data and the placeholder
`CostDrillView` body with real data fetched from
`GET /pods/analytics/cost`. This is the brief that delivers the
user-visible outcome.

### `CostAnalyticsResponse` Swift mirror

Create
`packages/desktop/Sources/AutopodClient/Types/CostAnalyticsResponse.swift`.
Decodable struct hierarchy mirroring `design.md` → Contracts → Cost
analytics response:

```swift
public struct CostAnalyticsResponse: Decodable, Equatable {
    public let total: Double
    public let sparkline: [SparklinePoint]
    public let deltaVsPrior: CostDelta
    public let byPhase: [PhaseSegment]
    public let byProfileModel: [ProfileModelCell]
    public let top10: [TopPodEntry]
    public let waste: WasteSummary
}

public struct SparklinePoint: Decodable, Equatable {
    public let day: String   // "YYYY-MM-DD"
    public let costUsd: Double
}

public struct CostDelta: Decodable, Equatable {
    public let value: Double
    public let direction: Direction
    public enum Direction: String, Decodable { case up, down, flat }
}

public struct PhaseSegment: Decodable, Equatable {
    public let phase: String   // "agent_initial", "agent_rework_1", "review", "plan_eval", "agent_legacy"
    public let costUsd: Double
}

public struct ProfileModelCell: Decodable, Equatable {
    public let profile: String
    public let model: String?
    public let costUsd: Double
    public let podCount: Int
}

public struct TopPodEntry: Decodable, Equatable {
    public let podId: String
    public let profile: String
    public let model: String?
    public let finalStatus: String   // "complete" | "killed" | "failed" | "rejected"
    public let costUsd: Double
    public let completedAt: String   // ISO
}

public struct WasteSummary: Decodable, Equatable {
    public let total: Double
    public let podCount: Int
}
```

### `DaemonAPI` method

Add to `packages/desktop/Sources/AutopodClient/DaemonAPI.swift`:

```swift
public func getCostAnalytics(days: Int = 30) async throws -> CostAnalyticsResponse {
    try await get("/pods/analytics/cost?days=\(days)")
}
```

Place the method adjacent to `getSessionStats` and other read
methods. Use whatever the existing `get(_:)` helper is — match the
pattern used by `getSessionStats` rather than introducing a new
fetch shape.

### Cost card data wiring

In `AnalyticsView.swift`, the Cost card today is rendered with
`sparkline: nil`, `delta: nil` (Phase 0 wiring). Phase 1:

1. Add `@State private var costData: CostAnalyticsResponse? = nil`,
   `@State private var costLoadError: String? = nil`,
   `@State private var isLoadingCost: Bool = false`.
2. Add a `loadCost: (() async throws -> CostAnalyticsResponse)?` prop
   following the same shape as the existing `loadScores` prop. Caller
   in `MainView` wires it to `daemonAPI.getCostAnalytics(days: 30)`.
3. In `.task`, call `loadCost` once and populate `costData`. On
   error, set `costLoadError` and leave `costData` nil.
4. Cost card props: when `costData != nil`, set
   `value` to `String(format: "$%.2f", costData.total)`,
   `sparkline` to `costData.sparkline.map(\.costUsd)`,
   `delta` to `AnalyticsCardDelta(value: formatDelta(costData.deltaVsPrior),
   direction: .init(costData.deltaVsPrior.direction))`.
   When `nil` (loading or error), pass `nil` for sparkline and delta
   and `value` as `"—"`.

The existing Quality and Status cards are unchanged.

### CostDrillView body

`CostDrillView` was added in Phase 0 as a placeholder inside
`AnalyticsView.swift`. Phase 1 fills the body with a single
`ScrollView` containing four sections in order:

1. **`CostPhaseBarSectionView`** — a stacked `Charts.BarMark`
   visualization of `costData.byPhase`. One stacked bar (single
   x-category, e.g. "Last 30 days"); each phase is a stacked
   segment with a distinct color and the phase name + dollar amount
   in a legend below. If `byPhase.count > 7`, collapse all
   `agent_rework_<N>` segments with index > 5 into a single
   `"agent_rework_6+"` segment for display (sum the dollars).

2. **`CostProfileModelSectionView`** — a grid view of
   `costData.byProfileModel`. Use a `LazyVGrid` with rows being
   `[GridItem(.fixed(160))]` for the profile column and adaptive
   columns for models. Cells show `$X.XX` with the pod count below
   in `.secondary`. If there are more models than fit, the section
   gets a horizontal scroll. Empty state: `"No profile / model
   data."`

3. **`CostTop10SectionView`** — a `VStack` of clickable rows. Each
   row: `HStack` with pod ID short (`String(podId.prefix(8))`),
   profile, model, status badge (color-coded), and cost (right
   aligned, monospaced digits). On tap, fire the `onSelectPod`
   callback (already plumbed in Phase 0 by
   `AnalyticsRightPaneView`). Empty state: `"No pods in window."`

4. **`CostWasteCalloutView`** — single styled card. Title `"Cost
   waste"`, big `"$X.XX"` number, subtitle `"across N pods"`. The
   visual style should echo the existing `AnalyticsCard` material
   shell but without the click target (waste is a passive callout).

All four sections take `costData` as input and render only the
relevant slice. Loading: skeleton placeholders. Error: inline error
banner above the sections.

Implement the four section views as `private struct` declarations
inside `AnalyticsView.swift`. They are not reused elsewhere; one
file keeps the diff focused. If `AnalyticsView.swift` exceeds ~700
lines after this brief, *then* split — don't pre-emptively factor.

### MainView wiring (one-liner)

In `MainView.swift`, the existing call site that constructs
`AnalyticsView(pods:, loadScores:, onSelectPod:)` adds the new
`loadCost` parameter. Phase 0 plumbed `loadScores` from `MainView`
to `AnalyticsView`; Phase 1 mirrors that plumbing for `loadCost`.

NOTE: `MainView.swift` is in `does_not_touch` — but the call site
edit is one parameter addition. The `does_not_touch` rule is
advisory; the reviewer adjudicates. Make the edit; explain in the
PR body that it's a single-line additive change.

Actually — re-evaluate: if the call site edit is unavoidable, move
`MainView.swift` from `does_not_touch` to `touches` in the file
header at the top of this brief. Don't fight the advisory list.
The reviewer needs an honest list.

(Brief writers: yes, this means the YAML frontmatter `touches`
should include `MainView.swift`. Caught it during writing — keep
it consistent.)

## Touches

- `packages/desktop/Sources/AutopodClient/Types/CostAnalyticsResponse.swift` (new)
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` (new method)
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` (Cost card data + four drill subviews)
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` (add `loadCost:` to the `AnalyticsView` call site — one parameter addition)

## Does not touch

- `Models/AnalyticsSection.swift`, `Models/AnalyticsCardKind.swift`,
  `Views/Analytics/AnalyticsCard.swift`,
  `Views/Analytics/AnalyticsRightPaneView.swift` — Phase 0 contracts;
  this brief consumes them unchanged.
- `Views/Shell/SidebarView.swift` — Cost section stays disabled
  (per `purpose.md` → Non-goals).
- `packages/daemon/` — Brief 03 finished the daemon side.

## Constraints

From `design.md` → UX flows: card is non-interactive when costData is
nil; drill renders skeletons during load; top-10 click clears the
selected card and switches sidebar (Phase 0 plumbing).

From `purpose.md` → Non-goals: the dedicated Cost section in the
sidebar stays disabled. Phase 1 fills the *card on Overview* and its
right-pane drill — it does not unlock the dedicated Cost section.

From Phase 0's `AnalyticsCard` API: `value: String`, `sparkline:
[Double]?`, `delta: AnalyticsCardDelta?`, `isSelected: Bool`,
`onClick: () -> Void`. Don't widen the API; pass strings already
formatted.

## Test expectations

Add `Tests/AutopodClientTests/CostAnalyticsResponseTests.swift`:

- Decoding round-trip: feed a JSON fixture matching the contract,
  decode to `CostAnalyticsResponse`, confirm all fields match.
- Decoding handles missing optional `model: null` correctly.
- `CostDelta.Direction` decodes `"up"`, `"down"`, `"flat"` to the
  matching cases; rejects unknown strings.
- `SparklinePoint` decodes a 30-element array.

These tests do NOT run in the autopod validation pipeline (it does
not invoke `swift test`). They run when the user invokes
`swift test` locally on the desktop package.

## Risks / pitfalls

- **`Charts.BarMark` API on macOS 15** — stacked bars use
  `.position(by:)` with an enum or string. The model is fine; if
  rendering looks off (segments overlapping or bar disappearing),
  the most likely cause is forgetting to map `phase` to a
  `PlottableValue`. Fall back to a custom `Path` only if `Charts`
  truly can't render the shape.
- **High-N rework collapse** — without the `agent_rework_6+`
  collapse, a pod with 30 reworks produces a 30-segment legend that
  overflows the right pane. Implement the collapse from the start.
- **Color palette for stacked bars** — pick a deterministic
  per-phase color so the legend reads stably across loads. A static
  dictionary `["agent_initial": .blue, "review": .orange, ...]`
  with a hashed fallback for `agent_rework_<N>` works.
- **Date-string parsing in sparkline** — the `day` field is
  `"YYYY-MM-DD"`. Don't try to `DateFormatter` it for the chart's
  x-axis label; just use the index. Tooltip can show the date
  string directly.
- **Status badge colors must match existing convention** — there's
  already a status-color mapping somewhere (likely
  `Views/Cards/PodCardFinal.swift` or a `StatusBadge` shared view).
  Reuse it; don't introduce a new color scheme.
- **`AnalyticsView.swift` size after this brief** — if it goes
  past ~700 lines, factor each `Cost*SectionView` into its own
  file. But don't factor pre-emptively; let the size dictate.

## Wrap-up

1. Run `/simplify` and address findings.
2. Build with `swift build` (or open `Autopod.xcodeproj` and build) to
   verify no Swift type errors. Run `swift test` to verify the
   `CostAnalyticsResponseTests` pass.
3. **Manual verification:**
   - Start the daemon (with at least a few terminal pods in the DB
     across the last 30 days).
   - Open the desktop app → Analytics > Overview → Cost card shows
     non-`"—"` value, a sparkline shape, and a delta indicator.
   - Click the Cost card → drill renders all four sections in order:
     phase bar, profile×model grid, top-10 list, waste callout.
   - Click a top-10 row → sidebar switches to All Pods, that pod is
     selected.
   - Click the Cost card again → drill returns to empty state (Phase
     0 toggle-off behaviour).
   - Verify a non-Claude pod (Codex / Copilot) shows up with a
     non-zero cost (proves pricing module is wired).
   - Verify the Cost sub-row in the sidebar is still disabled.
4. Commit and push.
