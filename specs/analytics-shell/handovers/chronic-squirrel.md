# Handover: chronic-squirrel (Brief 02 — Analytics Card Components)

## What was built

Three new purely-additive Swift types in `packages/desktop/Sources/AutopodUI/`:

- **`Models/AnalyticsCardKind.swift`** — `AnalyticsCardKind: String, Hashable` enum with cases `.cost`, `.quality`, `.status`. The drill-in discriminator held as `@State` in `MainView`.
- **`Views/Analytics/AnalyticsCard.swift`** — Clickable summary tile. Includes `AnalyticsCardDelta` struct (with `Direction` enum), `AnalyticsCard` view, and private `CardSparklineView`. Visual language matches `PodCardFinal` exactly (corner-radius 10, `controlBackgroundColor`, same shadow/stroke/hover values).
- **`Views/Analytics/AnalyticsRightPaneView.swift`** — Pure-function right-pane host. `card == nil` renders empty state; `card != nil` renders placeholder text. `pods`, `loadScores`, `onSelectPod` accepted but unused — stable call-site for Brief 03.

Tests added: `Tests/AutopodClientTests/AnalyticsCardKindTests.swift` — rawValue and Hashable round-trip.

## Interfaces / contracts

All API shapes match `design.md` exactly:

```swift
public enum AnalyticsCardKind: String, Hashable { case cost, quality, status }

public struct AnalyticsCard: View {
    public let title: String; public let value: String
    public let sparkline: [Double]?; public let delta: AnalyticsCardDelta?
    public let isSelected: Bool; public let onClick: () -> Void
}

public struct AnalyticsCardDelta {
    public enum Direction { case up, down, flat }
    public let value: String; public let direction: Direction
    public init(value: String, direction: Direction)
}

public struct AnalyticsRightPaneView: View {
    public let card: AnalyticsCardKind?; public let pods: [Pod]
    public let loadScores: (() async throws -> [PodQualityScore])?
    public let onSelectPod: ((String) -> Void)?
}
```

## Deviations from spec

1. **Card background**: Brief said `.regularMaterial`; used `Color(nsColor: .controlBackgroundColor)` to match every other card in the codebase (`PodCardFinal`, `SessionQualityCard`). The `.regularMaterial` spec was contradicted by "match their style" in the same sentence.

2. **Sparkline**: Brief said use `Charts` (`LineMark`); used a custom `Path`-based sparkline because `Charts` is not declared as a dependency in `Package.swift`. The brief explicitly anticipated this fallback. Flagged in commit message for a follow-up to decide whether to add Charts.

## Files Brief 03 must own

Brief 03 should replace the `card != nil` branch in `AnalyticsRightPaneView.swift` (currently a placeholder) with real drill subviews. It also wires `AnalyticsCard` into `AnalyticsView.swift` and `MainView.swift`.

Do **not** modify `AnalyticsCard.swift` or `AnalyticsRightPaneView.swift` except to replace the placeholder branch — the public API signatures are contracted and downstream call sites depend on them.

## Landmines / constraints

- `AnalyticsSection.swift` (Brief 01 / disabled-herring) did **not exist** on the `autopod/disabled-herring` branch when this pod started. Brief 02 has no dependency on it, so work proceeded. Brief 03 depends on `AnalyticsSection` for sidebar routing — verify it exists before starting that brief.
- `Charts` is absent from `Package.swift`. If Brief 03 wants a smoother sparkline, the dependency must be added to the `AutopodUI` target first.
- `fileprivate` on `AnalyticsCardDelta.Direction`'s `systemImage`/`color` extensions is intentional — `private` would restrict access to the extension block only, breaking `AnalyticsCard.body` which reads them from a different type in the same file.
