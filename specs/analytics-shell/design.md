# Design — Analytics Shell

## Blast radius

Existing files modified:
- `packages/desktop/Sources/AutopodUI/Views/Shell/SidebarView.swift` — adds nested rows under Analytics, including `.disabled(true)` for unshipped sections. Replaces the flat `SidebarItem.analytics` case with `SidebarItem.analyticsSection(AnalyticsSection)`.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` — adds `@State selectedAnalyticsCard: AnalyticsCardKind?`, routes the content + detail panes for `.analyticsSection(_)` cases.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` — refactored: middle pane becomes a card grid of three `AnalyticsCard`s; existing deeper sections become drill subviews the right pane can host.

New files:
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift` — sub-route enum.
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift` — clicked-card enum.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsCard.swift` — reusable card component.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift` — right-pane host that switches on `AnalyticsCardKind`.

Untouched:
- `Views/Detail/DetailPanelView.swift` (continues to handle pod-detail).
- `Views/Cards/PodCardFinal.swift`, `Views/Shared/SessionQualityCard.swift`, `Views/Shared/StatTile.swift` (reusable components, not modified).
- `Views/Analytics/HistoryView.swift` (out of scope).
- All daemon code. No migrations. No SQL. No daemon API.

## Seams

Three brief boundaries, executed sequentially:

1. **Sidebar routing seam (Brief 01).** Adds `AnalyticsSection` and a new `SidebarItem.analyticsSection(_)` case. Renders nested rows. Routes `MainView` content based on the section. Brief 03 will add right-pane state; Brief 01 leaves the existing right-pane logic alone.
2. **Component seam (Brief 02).** New `AnalyticsCard` view, `AnalyticsRightPaneView` host, `AnalyticsCardKind` enum. Pure additive — none of these are wired yet.
3. **Refactor + wiring seam (Brief 03).** Splits `AnalyticsView` into the Overview card grid + per-card drill subviews. Wires `MainView`'s `selectedAnalyticsCard` state to both `AnalyticsView` (clicks set it, with toggle-off behavior) and `AnalyticsRightPaneView` (renders empty or drill).

Sequential execution is the right ordering even though Brief 02 has no hard file collision with Brief 01: Phase 0 has no automated verification, so the user wants to verify each brief manually before the next ships.

## Contracts

`AnalyticsSection`:

```swift
public enum AnalyticsSection: String, CaseIterable, Hashable {
    case overview, cost, reliability, quality, safety, throughput, models

    /// True for sections whose content has shipped. Disabled sidebar rows for
    /// sections returning `false` are not user-clickable.
    public var isShipped: Bool {
        self == .overview
    }

    public var label: String { /* "Overview", "Cost", … */ }
    public var icon: String { /* SF Symbol per section */ }
}
```

`AnalyticsCardKind`:

```swift
public enum AnalyticsCardKind: String, Hashable {
    case cost, quality, status
}
```

`SidebarItem` extension:

```swift
public enum SidebarItem: Hashable {
    // existing cases preserved …
    case analyticsSection(AnalyticsSection)
    // The flat .analytics case (SidebarView.swift:239) is REMOVED. Replace every
    // exhaustive switch reference with .analyticsSection(.overview) or a wildcard
    // .analyticsSection(_) per the call site's intent.
}
```

`MainView` adds:

```swift
@State private var selectedAnalyticsCard: AnalyticsCardKind?
```

`AnalyticsCard` API:

```swift
public struct AnalyticsCard: View {
    public let title: String
    public let value: String
    public let sparkline: [Double]?       // nil hides the sparkline area; nil in Phase 0
    public let delta: AnalyticsCardDelta? // nil hides the delta line; nil in Phase 0
    public let isSelected: Bool
    public let onClick: () -> Void
}

public struct AnalyticsCardDelta {
    public enum Direction { case up, down, flat }
    public let value: String   // e.g. "+18%"
    public let direction: Direction
}
```

`AnalyticsRightPaneView` API:

```swift
public struct AnalyticsRightPaneView: View {
    public let card: AnalyticsCardKind?  // nil = empty state
    public let pods: [Pod]
    public let loadScores: (() async throws -> [PodQualityScore])?
    public let onSelectPod: ((String) -> Void)?
}
```

Card click handler in `AnalyticsView` (toggle-off semantics):

```swift
onClick: {
    selectedCard.wrappedValue = (selectedCard.wrappedValue == .cost) ? nil : .cost
}
```

Detail-pane branch in `MainView`:

```swift
} detail: {
    if case .analyticsSection = sidebarSelection {
        AnalyticsRightPaneView(
            card: selectedAnalyticsCard,
            pods: pods,
            loadScores: loadQualityScores,
            onSelectPod: { selectedAnalyticsCard = nil; sidebarSelection = .all; selectedSessionId = $0 }
        )
    } else if /* existing salesPitch / featureOverview / pod-detail branches */
}
```

Owners by brief:
- `AnalyticsSection` produced by Brief 01, consumed by Brief 03.
- `AnalyticsCardKind` produced by Brief 02, consumed by Brief 03.
- `AnalyticsCard` + `AnalyticsRightPaneView` produced by Brief 02, consumed by Brief 03.

## UX flows

**Entry:** user clicks Analytics in sidebar → row expands (or is already expanded) → Overview row is auto-selected → middle pane shows three Cards → right pane shows empty state (`📊 Click a card to drill in`).

**Drill-in:** user clicks a Card → Card visually marks as selected → right pane swaps to per-card drill (Cost: profile rows; Quality: runtime/model + scores table; Status: expanded proportion bar with legend). Card style indicates it's the active drill.

**Toggle-off:** user clicks the same Card again → `selectedAnalyticsCard` set to `nil` → right pane returns to empty state → Card visually deselects.

**Switch drill:** user clicks a different Card while another is selected → `selectedAnalyticsCard` set to the new kind (no toggle-off when switching kinds; both transitions in a single click).

**Cross-section persistence:** user clicks Attention sidebar → middle pane switches to fleet view, right pane switches to pod-detail logic. `selectedAnalyticsCard` is preserved as `@State`. User clicks Analytics > Overview → drill is restored.

**Disabled section:** user attempts to click Cost / Reliability / etc. in the sidebar → `.disabled(true)` row is non-interactive (no selection change). Visual cue is the standard SwiftUI disabled-row treatment.

**Quality drill → pod navigation:** clicking a row in the scores table fires `onSelectPod`. The handler clears `selectedAnalyticsCard` first (so the card doesn't appear pre-selected when the user returns to Analytics), then switches `sidebarSelection` to `.all` and sets `selectedSessionId`.

## Reference reading

- `packages/desktop/Sources/AutopodUI/Views/Features/FeatureOverviewView.swift` and `FeatureDetailPanelView.swift` — the precedent we are copying. `MainView.swift:179` (`@State selectedFeature`) and `MainView.swift:357–372` (detail-branch selection) show the exact pattern: state lives in `MainView`, content view sets it on click, detail view reads it. Honor this shape.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:204–227` — `filteredSessions` switch shows where new `.analyticsSection(_)` cases need to return `[]` so the fleet filtering logic doesn't engage on analytics rows.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:239–404` — the `NavigationSplitView`'s content + detail closures are the routing surface.
- `packages/desktop/Sources/AutopodUI/Views/Shell/SidebarView.swift:90–103` — current `List(selection:)` shape; nested rows go inside or after the existing `Section("Pods")`. `.disabled(true)` per row is the disablement mechanism.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift:60–93` — current section list (`heroStats`, `secondaryStats`, `statusProportionBar`, `profileBreakdown`, `qualitySection`). Brief 03 splits these along Overview-card vs drill-in lines.
- `packages/desktop/Sources/AutopodUI/Views/Shared/StatTile.swift` — informational tile (no click target). Don't extend it; introduce `AnalyticsCard` separately. StatTile stays the right primitive for non-clickable stat displays elsewhere.
- `packages/desktop/Package.swift` — declares `.macOS(.v15)` only. Validation containers are Linux + cannot build these targets. Drives the "zero ACs" decision in `purpose.md`.
- `docs/analytics-dashboard-plan.md` — the multi-phase plan this Phase 0 is the foundation of. Future phases fill the disabled sub-rows; choices here should not preclude that.
- Plan-feature output convention `specs/<feature>/handovers/` — runtime artifact. Pods write per-pod-id handover files; not authored at planning time.

## Decisions

None. No ADRs introduced. No hard-to-reverse choices. All changes are pure UI refactor + additive components, fully reversible by `git revert`.
