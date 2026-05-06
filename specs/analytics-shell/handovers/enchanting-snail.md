# Handover — enchanting-snail (Brief 01: Analytics routing chassis)

## What was built

Added the analytics sub-route routing chassis for the macOS desktop app.

**New file:** `Sources/AutopodUI/Models/AnalyticsSection.swift`
- `public enum AnalyticsSection: String, CaseIterable, Hashable` with 7 cases: `.overview`, `.cost`, `.reliability`, `.quality`, `.safety`, `.throughput`, `.models`
- `isShipped: Bool` — `true` only for `.overview`. This is the single source of truth for sidebar interactivity; sidebar code reads it, does not duplicate the decision.
- `label: String`, `icon: String` (SF Symbol names), `phaseNumber: Int` (internal — used only for placeholder text in MainView)

**Modified:** `SidebarView.swift`
- `SidebarItem.analytics` case removed; replaced with `SidebarItem.analyticsSection(AnalyticsSection)`
- `SidebarItem.label` switch updated accordingly
- Sidebar now has a `Section("Analytics")` with 7 rows via `ForEach(AnalyticsSection.allCases)`. Rows where `isShipped == false` are `.disabled(true)` with tertiary foreground styling.

**Modified:** `MainView.swift`
- `filteredSessions` delegates to new `static func filterPods(_ pods: [Pod], for selection: SidebarItem) -> [Pod]`. All `.analyticsSection(_)` values return `[]`.
- Content pane: `if case .analyticsSection(let section) = sidebarSelection` — `.overview` renders `AnalyticsView` unchanged; other sections render a centered placeholder (`"\(section.label) analytics — ships in Phase \(section.phaseNumber)"`).
- Detail pane: **unchanged** — Brief 03 owns right-pane wiring.

**New test file:** `Tests/AutopodClientTests/AnalyticsSectionTests.swift`
- Covers: `allCases` order, `isShipped` true/false, Hashable equality round-trip, `filterPods` returns `[]` for all 7 analytics sections.
- `filterPods` test uses `let pods: [Pod] = []` — analytics sections return `[]` regardless of input, so an empty fixture is sufficient.
- `@testable import AutopodUI` compiles because `Package.swift` already declared `AutopodUI` as a dependency of `AutopodClientTests` before this PR (line 42: `dependencies: ["AutopodClient", "AutopodUI", "AutopodDesktop"]`). No `Package.swift` change was needed.

## Deviations from brief

None. The implementation follows the brief exactly.

## Interfaces / contracts the next pod must know

- `AnalyticsSection` is in `AutopodUI`; `SidebarItem.analyticsSection(AnalyticsSection)` is the routing case.
- `AnalyticsSection.isShipped` is the gating predicate. Brief 02/03 must not duplicate this logic.
- `MainView.filterPods` is `internal static` — accessible via `@testable import AutopodUI`.
- `AnalyticsSection.phaseNumber` is intentionally `internal` (not `public`). If Brief 02/03 needs it from outside the module, make it `public` at that point.
- The detail pane has no `.analyticsSection` branch yet — `selectedSession == nil` falls through to `emptyDetail`. Brief 03 wires `AnalyticsRightPaneView` here.
- `@State private var selectedAnalyticsCard: AnalyticsCardKind?` is **not yet added** to `MainView` — Brief 03 adds it.

## Files you should not modify without good reason

- `Sources/AutopodUI/Models/AnalyticsSection.swift` — this is the contract enum; Brief 02 and 03 consume it, not modify it (unless adding `phaseNumber` public access).
- `Sources/AutopodUI/Views/Shell/MainView.swift:filterPods` — exhaustive switch with no `default:` clause by design; the compiler will surface any new `SidebarItem` cases that need handling.

## Discovered constraints / landmines

- **No `default:` in `filterPods` switch** — intentional. Never add one; missing cases must surface as compiler errors.
- **`DisclosureGroup` avoided** — used `Section("Analytics")` instead of `DisclosureGroup` for the nested analytics rows. `Section` integrates cleanly with `List(selection:)` on macOS. If Brief 02/03 revisits this, be aware that `DisclosureGroup` inside `List` on macOS has known selection edge cases.
- **Swift build not verified in CI** — the validation pipeline runs JS/TS only. Swift correctness must be verified locally with `swift build` / `swift test` in `packages/desktop`. All 2088 JS/TS tests pass.
