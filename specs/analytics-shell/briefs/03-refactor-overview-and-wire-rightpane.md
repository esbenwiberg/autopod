---
title: "Refactor AnalyticsView to Overview card grid and wire right pane"
depends_on: [02-add-analytics-card-and-rightpane]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
does_not_touch:
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsCard.swift
  - packages/desktop/Sources/AutopodUI/Views/Shared/StatTile.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/HistoryView.swift
  - packages/daemon/
---

## Task

Wire the components from Briefs 01 + 02 together. Three things happen here:

### 1. Refactor `AnalyticsView` into a card grid

Today `AnalyticsView` is a single stacked `ScrollView` rendering hero stats, secondary stats, status proportion bar, profile breakdown, and quality section (`AnalyticsView.swift:60–93`). Phase 0 splits this:

- **Middle pane (Overview):** card grid with three `AnalyticsCard`s — Cost, Quality, Status. Use `LazyVGrid` with adaptive columns (~280pt min) so it reflows on window resize.
- **Drill subviews (rendered by the right pane):** the existing deeper sections, extracted into three new internal types in `AnalyticsView.swift`:
  - `CostDrillView` — wraps the existing `profileBreakdown` content (per-profile cost rows). Inputs: `pods: [Pod]`.
  - `QualityDrillView` — wraps the existing `qualitySection` content (runtime/model summary cards + scores table). Inputs: `pods: [Pod]`, `loadScores: () async throws -> [PodQualityScore]`, `onSelectPod: (String) -> Void`.
  - `StatusDrillView` — wraps the existing `statusProportionBar` content, *expanded*: the proportion bar + a row-style legend listing each status with its count and color swatch (today's legend is compact tags above the bar; the drill version gets one row per status with more breathing room).

Card values for Phase 0:

- **Cost card:** title `"Cost"`, value formatted total cost across `pods` (e.g. `"$12.34"`). `sparkline: nil`, `delta: nil`.
- **Quality card:** title `"Quality"`, value average quality score across pods that have one (e.g. `"82"`). `sparkline: nil`, `delta: nil`. If no pods have scores, show `"—"`.
- **Status card:** title `"Status"`, value the count of pods in the dominant status (e.g. `"14 running"`). `sparkline: nil`, `delta: nil`.

The values come from the same data `AnalyticsView` already aggregates — copy those calculations from the existing `heroStats` / `secondaryStats` builders. Don't introduce new aggregations.

**Deliberately dropped from view in Phase 0:** today's `secondaryStats` row (pod count, success rate, lines added, input/output tokens). Per `purpose.md` → Success signal: "Today's secondary stats … are deliberately not shown — they re-appear in later phases." Delete the secondary stats rendering. The aggregations themselves can stay if they're cheap; just don't render them.

### 2. Wire `MainView`

Add the state:

```swift
@State private var selectedAnalyticsCard: AnalyticsCardKind?
```

Place it next to `selectedFeature` at `MainView.swift:179` for consistency.

Update the content closure: when `sidebarSelection` is `.analyticsSection(.overview)`, render `AnalyticsView` and pass a binding to `selectedAnalyticsCard` so the cards can set/clear it. The other six `.analyticsSection(_)` cases continue to render the placeholder middle pane introduced in Brief 01.

Update the detail closure (today branches between sales-pitch / feature-overview / pod-detail at `MainView.swift:357–402`). Add a new branch:

```swift
} detail: {
    if case .analyticsSection = sidebarSelection {
        AnalyticsRightPaneView(
            card: selectedAnalyticsCard,
            pods: pods,
            loadScores: loadQualityScores,
            onSelectPod: { sessionId in
                selectedAnalyticsCard = nil
                sidebarSelection = .all
                selectedSessionId = sessionId
            }
        )
    } else if /* existing branches preserved */
}
```

`loadQualityScores` is whatever closure / method `AnalyticsView` uses today to fetch scores — pass the same one. If it's currently inline in `AnalyticsView`, lift it to `MainView` (or to a small free function in `AnalyticsView.swift`) so both `AnalyticsView` and `AnalyticsRightPaneView` can reach it.

### 3. Replace the placeholder branch in `AnalyticsRightPaneView`

The `card != nil` placeholder from Brief 02 gets replaced with the real switch:

```swift
switch card {
case .cost:    CostDrillView(pods: pods)
case .quality: QualityDrillView(pods: pods, loadScores: loadScores, onSelectPod: onSelectPod)
case .status:  StatusDrillView(pods: pods)
case .none:    /* empty state from Brief 02 */
}
```

Force-unwrap is fine here because `card != nil` is the case branch — but an exhaustive `switch card` is cleaner and the compiler enforces all cases.

`CostDrillView` / `QualityDrillView` / `StatusDrillView` live in `AnalyticsView.swift` (same file as the Overview), declared `internal`. Don't put them in separate files for Phase 0 — they're tightly coupled to `AnalyticsView`'s data shape and may move together in a later phase.

### Card click handler — toggle-off semantics

Inside `AnalyticsView`, each card's `onClick` toggles:

```swift
onClick: {
    selectedCard.wrappedValue = (selectedCard.wrappedValue == .cost) ? nil : .cost
}
```

(Substitute `.quality` / `.status` for the other two.) The card's `isSelected` is `selectedCard.wrappedValue == .cost` (etc).

## Touches

- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` — refactor into Overview + three drill subviews.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift` — replace the placeholder branch with the real drill switch.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` — add `@State selectedAnalyticsCard`, update content + detail branches.

## Does not touch

- `AnalyticsSection.swift`, `AnalyticsCardKind.swift`, `AnalyticsCard.swift` — produced by 01/02; this brief consumes them.
- `StatTile.swift` — informational primitive, untouched.
- `DetailPanelView.swift` — pod-detail logic preserved as-is; the analytics branch routes around it via `if case .analyticsSection = sidebarSelection`.
- `HistoryView.swift` — out of scope per `purpose.md` → Non-goals.
- Daemon — Phase 0 is UI-only.

## Constraints

From `design.md` → Contracts: the `MainView` detail-pane branch shape is exact. The `onSelectPod` handler MUST clear `selectedAnalyticsCard` before switching sidebar — otherwise when the user navigates back to Analytics > Overview, the previously-selected card appears active without a corresponding right-pane drill (until the user clicks something).

From `design.md` → UX flows → Cross-section persistence: `selectedAnalyticsCard` lives in `MainView` and is preserved across sidebar navigation. When the user goes Analytics > Cost-card-clicked → Attention → back to Analytics > Overview, the Cost card is still selected and the right pane still shows the Cost drill. Don't reset it on sidebar change.

From `design.md` → Reference reading: the `selectedFeature` / `FeatureOverview` / `FeatureDetailPanelView` triad (`MainView.swift:179, 357–372`) is the precedent. Match its shape — state in `MainView`, content view writes via `Binding`, detail view reads. Don't introduce a `@StateObject` view-model for this.

## Test expectations

Add or extend `Tests/AutopodClientTests/AnalyticsWiringTests.swift`:

- Toggle-off semantics: simulate two clicks on Cost card → `selectedAnalyticsCard` ends as `nil`.
- Switch-drill semantics: click Cost (`selectedAnalyticsCard == .cost`), then click Quality → `selectedAnalyticsCard == .quality` (no nil intermediate).
- `onSelectPod` handler: when invoked with a session id, `selectedAnalyticsCard` becomes `nil`, `sidebarSelection` becomes `.all`, `selectedSessionId` becomes the passed id. If these state mutations aren't testable through `MainView` directly, factor the handler logic into a static helper that returns the new tuple `(card, sidebar, session)` and test the helper.

These tests don't run in the autopod validation pipeline. They run when the user invokes `swift test` locally.

## Risks / pitfalls

- **Lifting `loadQualityScores`** — if today's `AnalyticsView` fetches scores via a `@State`/`@StateObject` it owns, lifting that to `MainView` means moving the fetch lifecycle. Cleanest path: keep the fetch closure as a static or free function returning `[PodQualityScore]`, and have both views call it. Avoid introducing a shared view-model just for this.
- **`@State selectedAnalyticsCard` re-renders** — every change re-renders `MainView`, which means the entire content + detail closures re-evaluate. That's already how `selectedFeature` works, so the pattern is fine, but watch for unnecessary recomputation in the content closure (e.g. don't recompute `filteredSessions` inside the closure if it's already a computed property).
- **Drop of secondary stats may surprise the user** — `purpose.md` is explicit that this is intentional for Phase 0. Mention it in the commit message so it's not read as a regression.
- **`StatusDrillView`'s expanded legend** — the existing compact legend uses tag-style chips. The expanded version (one row per status) is a new layout — don't try to reuse the chip styling; it will look cramped at row scale. A simple `HStack { Circle().fill(color).frame(width: 10); Text(status); Spacer(); Text("\(count)") }` per row is fine.
- **Selection persistence and sidebar.history** — when sidebar selection moves to `.history`, `selectedAnalyticsCard` should still persist (per `design.md` → UX flows). Verify this isn't accidentally cleared by an `.onChange(of: sidebarSelection)` somewhere. If `MainView` already has such a handler for other reasons, audit it.

## Wrap-up

1. Run `/simplify` and address findings.
2. Build with `swift build` (or open `Autopod.xcodeproj` and build) to verify no Swift type errors. Run `swift test` to verify the wiring tests pass.
3. **Manual verification** — this is the gate per `purpose.md`:
   - Sidebar → Analytics > Overview → middle pane shows three cards (Cost, Quality, Status). No secondary stats row.
   - Right pane shows the empty state `"Click a card to drill in"` with the chart icon.
   - Click Cost → card visually selects (border highlight) → right pane shows per-profile breakdown rows.
   - Click Cost again → card deselects → right pane returns to empty state.
   - Click Quality → right pane shows runtime/model summary + sortable scores table. Click a row in the scores table → sidebar jumps to All Pods, that pod is selected, right pane is the standard pod-detail panel.
   - Click Status → right pane shows expanded proportion bar + row-style legend.
   - Click Cost, then click Attention in sidebar (fleet view), then click back to Analytics > Overview → Cost card is still selected and right pane still shows Cost drill.
   - Cost / Reliability / Quality / Safety / Throughput / Models sub-rows are visibly disabled and non-clickable.
4. Commit and push.
