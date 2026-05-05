---
title: "Add AnalyticsCard component and right-pane host"
depends_on: [01-add-analytics-section-routing]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsCard.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift
does_not_touch:
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shared/StatTile.swift
  - packages/daemon/
---

## Task

Pure additive brief. Introduce three new types — none of them are wired into any existing view yet. Brief 03 owns the wiring. Each type must compile and be previewable in isolation.

### `AnalyticsCardKind`

New file `Models/AnalyticsCardKind.swift`:

```swift
public enum AnalyticsCardKind: String, Hashable {
    case cost, quality, status
}
```

That's the entire enum. No methods, no associated values. It is the discriminator for which card was clicked.

### `AnalyticsCard`

New file `Views/Analytics/AnalyticsCard.swift`. A clickable summary tile rendered in the Overview card grid. API exactly:

```swift
public struct AnalyticsCard: View {
    public let title: String
    public let value: String
    public let sparkline: [Double]?       // nil hides the sparkline area
    public let delta: AnalyticsCardDelta? // nil hides the delta line
    public let isSelected: Bool
    public let onClick: () -> Void
}

public struct AnalyticsCardDelta {
    public enum Direction { case up, down, flat }
    public let value: String   // e.g. "+18%"
    public let direction: Direction
}
```

Visual spec:

- Rounded rectangle background, `.regularMaterial` fill (consistent with existing cards in the codebase — see `Views/Cards/PodCardFinal.swift` and `Views/Shared/SessionQualityCard.swift` for the existing card style; match their corner radius and padding).
- Title at top in `.subheadline` weight `.medium` `.secondary`.
- Value in `.largeTitle` weight `.bold`.
- Sparkline area: when `sparkline != nil`, render a small SwiftUI `Chart` line using the values; when `nil`, render nothing (no placeholder, no reserved space).
- Delta line: when `delta != nil`, render `Image(systemName:)` from direction (`arrow.up.right`, `arrow.down.right`, `arrow.right`) + the `value` string, in green/red/secondary accordingly. When `nil`, render nothing.
- Selected state: when `isSelected == true`, add a `.strokeBorder(Color.accentColor, lineWidth: 2)` overlay on the background. When `false`, render the standard subtle border (or no border, to match existing cards — pick whichever is consistent with `PodCardFinal`).
- Whole card is a button: `Button(action: onClick) { … }.buttonStyle(.plain)`.
- Hover feedback: subtle scale or shadow change. Use `.contentShape(Rectangle())` so the click target spans the full card.

Sparkline implementation note: use SwiftUI Charts (`Charts` framework) — it's available on macOS 13+, the desktop targets `.macOS(.v15)` per `Package.swift`, so no availability checks needed. `LineMark` with smoothed interpolation. Don't show axes or labels — it's decorative.

### `AnalyticsRightPaneView`

New file `Views/Analytics/AnalyticsRightPaneView.swift`. API exactly:

```swift
public struct AnalyticsRightPaneView: View {
    public let card: AnalyticsCardKind?
    public let pods: [Pod]
    public let loadScores: (() async throws -> [PodQualityScore])?
    public let onSelectPod: ((String) -> Void)?
}
```

When `card == nil`, render a centered empty state: SF Symbol `chart.bar.xaxis` (or similar) at `.system(size: 48)` weight `.thin` `.tertiary`, plus a single line `"Click a card to drill in"` in `.secondary`. Center vertically and horizontally.

When `card != nil`, **render a placeholder for now** — Brief 03 will wire the actual drill content. Placeholder shape: a vertically-centered `Text("\(card.rawValue) drill — wired in Brief 03")` so the routing is visibly working without committing to the final structure. Brief 03 replaces the body of the `card != nil` branch.

`pods`, `loadScores`, and `onSelectPod` are accepted but unused in this brief. They will be threaded through to the drill subviews in Brief 03. Marking them as parameters now means Brief 03 doesn't have to widen the call site signature; the wiring point in `MainView` is stable from Brief 01 onwards.

Don't add `@State` here. Don't add `@StateObject` or any kind of view-model. The right pane is a pure function of its inputs.

## Touches

- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift` (new)
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsCard.swift` (new)
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift` (new)

## Does not touch

- `AnalyticsView.swift`, `MainView.swift` — Brief 03 wires these.
- `StatTile.swift` — non-clickable primitive; deliberately separate from `AnalyticsCard` per `design.md` → Reference reading.
- Any daemon code.

## Constraints

From `design.md` → Contracts: the API shapes above are exact. Don't widen, don't narrow. Brief 03 depends on these signatures.

From `design.md` → Reference reading: `Views/Cards/PodCardFinal.swift` and `Views/Shared/SessionQualityCard.swift` set the visual language for cards. Match their corner radius, padding, and material.

`AnalyticsCard` is **clickable**; `StatTile` is **informational**. Keep them as separate types. Don't extend `StatTile` to take an optional `onClick`.

## Test expectations

Add `Tests/AutopodClientTests/AnalyticsCardKindTests.swift` (or extend the file from Brief 01 if it exists):

- `AnalyticsCardKind.cost.rawValue == "cost"`, etc. for all three.
- `AnalyticsCardKind` Hashable round-trip (insert into `Set`, look up).

No view-rendering tests — SwiftUI views are not unit-testable without `XCTAppKit` / snapshot infra we don't have. The diff reviewer + manual verification cover the visual layer.

Add a SwiftUI `#Preview` to both `AnalyticsCard.swift` and `AnalyticsRightPaneView.swift` so the user can verify the rendering in Xcode without running the full app:

- `AnalyticsCard` previews: one with `isSelected: false`, sparkline + delta nil; one with `isSelected: true`, sparkline `[1, 3, 2, 5, 4, 6]`, delta `.up "+18%"`.
- `AnalyticsRightPaneView` previews: one with `card: nil` (empty state); one with `card: .cost` (placeholder text).

## Risks / pitfalls

- **`Charts` framework import** — `import Charts` is required for the sparkline. If the file doesn't compile, the most likely cause is a missing import or the package not linking against `Charts` (it should, since `.macOS(.v15)` includes it by default for SwiftUI app targets, but if `Package.swift` declares the desktop target without the Charts dependency the sparkline won't compile — fall back to a custom `Path`-based mini-chart in that case rather than adding a dependency in this brief; flag it in the commit message so a follow-up can decide).
- **Material backgrounds on selection state** — stacking `.strokeBorder` on `.regularMaterial` can render weirdly on some macOS versions. Test on macOS 15 (the declared minimum). If it's ugly, use a solid color overlay at low opacity instead of stroke.
- **Click target sizing** — `Button` inside `LazyVGrid` cells can have inconsistent hit-testing if `contentShape` is missing. Always set `.contentShape(Rectangle())` before the `.onTapGesture`-equivalent.
- **Don't accidentally make `pods`/`loadScores`/`onSelectPod` non-optional** — they are unused in Brief 02, but Brief 03 will use them. Optional + nil-default is the right shape because callers in Brief 03 will provide real values.

## Wrap-up

1. Run `/simplify` and address findings.
2. Build with `swift build` (or open `Autopod.xcodeproj` and build) to verify no Swift type errors. Run `swift test` to verify the AnalyticsCardKind tests pass.
3. Open `AnalyticsCard.swift` in Xcode and verify the previews render: unselected card without sparkline, selected card with sparkline + delta. Open `AnalyticsRightPaneView.swift` and verify the empty state and `card: .cost` placeholder.
4. The component is unwired — there is nothing to verify in the running app. Brief 03 wires it.
5. Commit and push.
