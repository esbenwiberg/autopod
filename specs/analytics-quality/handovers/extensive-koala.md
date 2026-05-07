# Handover — extensive-koala (Brief 01: Sidebar Simplification)

## What was built

Collapsed the Analytics sidebar from seven sub-rows (one per `AnalyticsSection` case) to a
single flat `Analytics` row. The `AnalyticsSection` enum is deleted. The stale
"ships in Phase N" placeholder branch in `MainView` is gone.

### Files changed
- **Deleted**: `packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift`
- **Deleted**: `packages/desktop/Tests/AutopodClientTests/AnalyticsSectionTests.swift`
- **Modified**: `packages/desktop/Sources/AutopodUI/Views/Shell/SidebarView.swift`
  - `SidebarItem.analyticsSection(AnalyticsSection)` → `SidebarItem.analytics`
  - `SidebarItem.label` switch updated
  - `analyticsSectionRow(_:)` helper removed
  - `Section("Analytics") { ForEach(...) }` → `sidebarRow(.analytics, icon: "square.grid.2x2", color: .secondary, badge: 0)`
- **Modified**: `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift`
  - `filterPods` switch: `.analyticsSection` → `.analytics`
  - Content closure: replaced nested `if section == .overview / else placeholder` with
    `if sidebarSelection == .analytics { AnalyticsView(...) }`
  - Detail closure: `if case .analyticsSection = sidebarSelection` → `if sidebarSelection == .analytics`
- **Modified**: `packages/desktop/Tests/AutopodClientTests/AnalyticsWiringTests.swift`
  - Added `filterPodsReturnsEmptyForAnalytics()` test for the new flat case

## Interfaces / contracts changed

- `SidebarItem` (in `SidebarView.swift`) lost the `.analyticsSection(AnalyticsSection)` associated
  value case. Replaced by `.analytics` (no payload). Any code that pattern-matched
  `.analyticsSection(let section)` must be updated — none remains in the codebase after this PR.
- `AnalyticsSection` enum is gone from `AutopodUI`. Do not reference it.

## Files the next pod should NOT modify

- `packages/desktop/Sources/AutopodUI/Views/Shell/SidebarView.swift` — the `SidebarItem` enum is
  stable; Brief 03 only adds API wiring, not new sidebar cases.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` — the analytics content and detail
  branches are correct; Brief 03 threads `loadQualityAnalytics` through here, but the routing logic
  is settled.

## Discovered constraints / landmines

- `sidebarSelection` is `@State private var` — not persisted via `@AppStorage` or `@SceneStorage`.
  No migration concern when removing enum cases.
- The daemon test suite has a pre-existing failure in `reliability-aggregator.test.ts`
  (`table validations has no column named screenshots`) that is unrelated to this brief and was
  present on the base branch before any changes.
- The TypeScript/Node build (`pnpm build`) is completely unaffected — all changes are Swift-only.
