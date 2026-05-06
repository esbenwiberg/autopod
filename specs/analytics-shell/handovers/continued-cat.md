# Handover: continued-cat (Brief 03 — Analytics Wiring)

## What was built

Brief 03 wires the Brief 01 + 02 components together. Three files were refactored/extended:

**`AnalyticsView.swift`** — complete rewrite:
- `AnalyticsView` now renders a `LazyVGrid` (adaptive min 280pt) of three `AnalyticsCard`s (Cost, Quality, Status).
- `@Binding public var selectedCard: AnalyticsCardKind?` replaces the old `onSelectPod` parameter. Click handlers use toggle-off semantics.
- `secondaryStats` and `heroStats` rendering dropped (Phase 0 — re-appear later phases).
- Three internal drill subviews extracted into the same file:
  - `CostDrillView(pods:)` — per-profile cost rows (success rate bar, avg cost, lines added)
  - `QualityDrillView(pods:loadScores:onSelectPod:)` — runtime/model cards + sortable scores table; manages own `@State scores` async fetch
  - `StatusDrillView(pods:)` — proportion bar + row-style legend (one row per status, not compact chips)
- `@State private var scores` kept in `AnalyticsView` for the Quality card value (avg score); `QualityDrillView` fetches independently.
- File-level private helpers: `analyticsStatusCounts`, `analyticsScoreColor`, `analyticsRelativeDate`, `analyticsDailyAverages`, `SparklineView`.

**`AnalyticsRightPaneView.swift`** — replaced placeholder with exhaustive `switch card`:
- `.cost` → `CostDrillView`
- `.quality` → `QualityDrillView`
- `.status` → `StatusDrillView`
- `.none` → empty state (`chart.bar.xaxis` icon + "Click a card to drill in")

**`MainView.swift`**:
- Added `@State private var selectedAnalyticsCard: AnalyticsCardKind?` next to `selectedFeature`.
- Updated `.analyticsSection(.overview)` content branch to pass `$selectedAnalyticsCard` binding to `AnalyticsView`.
- Added `AnalyticsRightPaneView` as the first branch in the `detail` closure; the `onSelectPod` handler clears `selectedAnalyticsCard` before switching sidebar.
- Added two static helpers for unit tests: `toggleAnalyticsCard(_:tapping:)` and `analyticsSelectPodResult(sessionId:)`.

**`AnalyticsWiringTests.swift`** (new) — 8 tests covering:
- Toggle-off semantics (each card kind)
- Switch-drill semantics (no nil intermediate)
- `onSelectPod` handler state tuple

## Interfaces / contracts

`AnalyticsView` API changed — downstream must update call sites:
```swift
// REMOVED: onSelectPod parameter
// ADDED: selectedCard: Binding<AnalyticsCardKind?> = .constant(nil)
public init(
    pods: [Pod],
    loadScores: (() async throws -> [PodQualityScore])? = nil,
    selectedCard: Binding<AnalyticsCardKind?> = .constant(nil)
)
```

`MainView` new static helpers (stable, used by tests):
```swift
static func toggleAnalyticsCard(_ current: AnalyticsCardKind?, tapping: AnalyticsCardKind) -> AnalyticsCardKind?
static func analyticsSelectPodResult(sessionId: String) -> (card: AnalyticsCardKind?, sidebar: SidebarItem, session: String)
```

## Files next pod should NOT modify without good reason
- `AnalyticsView.swift` — owns `CostDrillView`, `QualityDrillView`, `StatusDrillView`. The drill subview file boundary is intentional for Phase 0; later phases may split them out.
- `AnalyticsRightPaneView.swift` — the switch is exhaustive on `AnalyticsCardKind`; adding a new card kind requires updating both the enum and this switch.
- `AnalyticsWiringTests.swift` — extend, don't replace.

## Deviations from spec

1. **`AnalyticsView` no longer passes `onSelectPod` to pod-row buttons** — this parameter was removed entirely. The Quality drill table's pod-navigation now flows exclusively through `QualityDrillView.onSelectPod`, which is threaded from `MainView` via `AnalyticsRightPaneView`. The spec anticipated this; no data flow is lost.
2. **`analyticsSelectPodResult` static helper kept** — quality reviewer flagged it as trivial, but the spec explicitly required a testable helper for the `onSelectPod` handler. Kept as specified.

## Discovered constraints / landmines

- `CostDrillView` and `StatusDrillView` recompute their stats from `pods` on every render (no memoisation). This is fine for typical fleet sizes (hundreds of pods), but if pod counts grow to thousands, profiling may flag these as hot.
- `QualityDrillView` and `AnalyticsView` both fetch quality scores independently. If both are visible simultaneously (card selected + overview card showing avg), two API calls fire. This is the intended design for Phase 0 (simple, no shared view-model) — a later phase can hoist fetch state into `MainView` if needed.
- `SparklineView` (file-scope private in `AnalyticsView.swift`) and `CardSparklineView` (private in `AnalyticsCard.swift`) are near-duplicates. Simplify flagged this; merging them requires touching `AnalyticsCard.swift` which is out of Brief 03 scope. Flag for the next phase that refactors card internals.
- The `analyticsStatusCounts` function (10 status filter passes) matches a similar pattern in `SeriesPipelineView`. Not merged — different output types. Future cleanup opportunity.
