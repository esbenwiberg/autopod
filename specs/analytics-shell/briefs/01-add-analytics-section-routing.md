---
title: "Add analytics section routing in sidebar and main view"
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/SidebarView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
does_not_touch:
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift
  - packages/daemon/
---

## Task

Introduce the analytics sub-route routing chassis. Add a new `AnalyticsSection` enum (`.overview`, `.cost`, `.reliability`, `.quality`, `.safety`, `.throughput`, `.models`) with an `isShipped` discriminator returning `true` only for `.overview`. Replace the flat `SidebarItem.analytics` case with `SidebarItem.analyticsSection(AnalyticsSection)`.

In the sidebar, render the seven sections as nested rows under the existing Analytics row. Use a `DisclosureGroup` (defaulting to expanded) or a plainly-indented additional `Section`, whichever integrates cleanest with `List(selection: $selection)`. Rows whose `isShipped` is `false` must be `.disabled(true)` so the user cannot select them.

In `MainView`, route `.analyticsSection(.overview)` to the existing `AnalyticsView` (no refactor yet — Brief 03 owns that). Route any other `.analyticsSection(_)` value to a placeholder middle pane that simply states which phase will fill the section ("Cost analytics — ships in Phase 1", "Reliability analytics — ships in Phase 2", etc.). The detail pane behavior is unchanged in this brief — the existing pod-detail logic continues to apply.

The `MainView.filteredSessions` switch at `MainView.swift:204–227` must return `[]` for any `.analyticsSection(_)` value so fleet filtering doesn't engage. Same for any other call site that exhaustively switches on `SidebarItem`.

## Touches

- `packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift` (new)
- `packages/desktop/Sources/AutopodUI/Views/Shell/SidebarView.swift`
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift`

## Does not touch

- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` — Brief 03 owns the refactor. Until then, `.analyticsSection(.overview)` renders `AnalyticsView` exactly as it is today.
- `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift` — Brief 03 wires the right pane.
- Anything in `packages/daemon/` — no daemon work in Phase 0.

## Constraints

From `design.md` → Reference reading: the precedent is `FeatureOverview` (`MainView.swift:179, 357–372`) — sub-state held in `MainView` as `@State`, content view writes it, detail view reads it. Brief 01 sets up routing only; the new state (`selectedAnalyticsCard`) is added in Brief 03.

From `design.md` → Contracts: `AnalyticsSection.isShipped` is the single source of truth for whether a sidebar row is interactive. Do not duplicate that decision in the sidebar code; read from the enum.

## Test expectations

Add `Tests/AutopodClientTests/AnalyticsSectionTests.swift` (introduce a UI-target test file if needed; Swift Package test target is `AutopodClientTests` per `Package.swift`). Cover:

- `AnalyticsSection.allCases` returns the seven cases in declared order: Overview, Cost, Reliability, Quality, Safety, Throughput, Models.
- `AnalyticsSection.overview.isShipped == true`.
- All other sections return `isShipped == false`.
- `SidebarItem.analyticsSection(.overview) == SidebarItem.analyticsSection(.overview)` (Hashable equality round-trip).
- `MainView.filteredSessions` returns an empty array when `sidebarSelection` is any `.analyticsSection(_)` value. If the filter logic is private, extract the switch to a static testable helper rather than making the property `internal` for tests.

These tests will not run in the autopod validation pipeline (it does not invoke `swift test`). They run when the user invokes `swift test` locally on the desktop package.

## Risks / pitfalls

- **`DisclosureGroup` inside `List(selection:)`** — selection routing through nested expandable rows is a known SwiftUI rough edge on macOS. Verify by hand: expanding/collapsing the group must not break selection of other rows; keyboard nav must skip disabled rows. If it doesn't behave, fallback is a flat additional `Section("Analytics")` with the children indented manually (no DisclosureGroup wrapper).
- **`SidebarItem.analytics` is referenced in multiple call sites** — `MainView.filteredSessions` switch, content branch, possibly elsewhere. Removing the flat case is a breaking refactor; let the compiler drive the migration. **Do not add a `default:` clause** to silence missing-case warnings — that would let later additions slip through unnoticed.
- **Disabled row tap behavior on macOS** — `.disabled(true)` on a `Label` inside a `List(selection:)` should make the row non-selectable, but visual feedback varies. If the disabled row still shows hover/press states, follow up with `.foregroundStyle(.tertiary)` on the icon and label to reinforce the disabled cue.

## Wrap-up

1. Run `/simplify` and address findings.
2. Build with `swift build` (or open `Autopod.xcodeproj` and build) to verify no Swift type errors. Run `swift test` to verify the new unit tests pass.
3. Manually verify in the running app: sidebar shows seven sub-rows under Analytics; Overview is selectable and shows the existing `AnalyticsView` unchanged; the other six rows are visibly disabled and non-clickable; clicking Attention/Active/etc. still works as before.
4. Commit and push.
