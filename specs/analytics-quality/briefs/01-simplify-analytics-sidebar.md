---
title: "Simplify Analytics sidebar to a single row"
acceptance_criteria:
  - { type: cmd, test: "! grep -rn 'ships in Phase' packages/desktop/Sources", pass: "no matches", fail: "any match means the stale phase placeholder text still ships in the desktop binary" }
  - { type: cmd, test: "! grep -rn 'AnalyticsSection\\.cost\\|AnalyticsSection\\.reliability\\|AnalyticsSection\\.quality\\|AnalyticsSection\\.safety\\|AnalyticsSection\\.throughput\\|AnalyticsSection\\.models' packages/desktop/Sources packages/desktop/Tests", pass: "no matches", fail: "any sub-row enum case is still referenced; the simplification is incomplete" }
touches:
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/SidebarView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
  - packages/desktop/Tests/AutopodClientTests/AnalyticsSectionTests.swift
  - packages/desktop/Tests/AutopodClientTests/AnalyticsWiringTests.swift
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/desktop/Sources/AutopodUI/Views/Analytics/
  - packages/desktop/Sources/AutopodClient/
---

## Task

Collapse the Analytics sidebar group from "one row per AnalyticsSection
case" to a single `Analytics` row. The card grid on the Overview screen
is already the navigation surface for analytics — the sub-rows are
redundant nav with worse affordance, and they are the source of the
stale "ships in Phase N" placeholder content.

Drop the `AnalyticsSection` enum entirely (or shrink it to a single
`.overview` case that no callers reference — deletion is cleaner). Wire
a flat `SidebarItem.analytics` case in its place. The sidebar's
`Section("Analytics")` block becomes one `sidebarRow(.analytics, …)`
call that opens the existing Overview view.

In `MainView`, remove the branch that distinguishes
`section == .overview` from non-overview sections (which renders the
"<Section> analytics — ships in Phase N" placeholder). Analytics
selection now always renders the Overview content in the middle pane
and the existing `AnalyticsRightPaneView` in the detail pane — same
flow as today's `.overview` path.

Tests for the deleted enum (`AnalyticsSectionTests.swift`) are removed.
Tests that asserted on the placeholder or on multi-section routing
(`AnalyticsWiringTests.swift`) are updated to reflect the single-row
sidebar.

## Touches

- `packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift` —
  delete this file.
- `packages/desktop/Sources/AutopodUI/Views/Shell/SidebarView.swift` —
  collapse the `Section("Analytics")` block (lines 104–109) to a single
  row; remove `analyticsSectionRow(_:)` helper (lines 210–219); replace
  the `case analyticsSection(AnalyticsSection)` in `SidebarItem`
  (line 256, plus its label branch around line 276) with a flat
  `case analytics`.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` —
  rewrite the `if case .analyticsSection(let section)` branch
  (lines 267–287) to just `if sidebarSelection == .analytics`,
  rendering the existing `AnalyticsView`. Update the matching
  `if case .analyticsSection = sidebarSelection` in the `detail`
  closure (line 365). Remove or simplify
  `analyticsSelectPodResult(sessionId:)` if it switched on
  sub-sections.
- `packages/desktop/Tests/AutopodClientTests/AnalyticsSectionTests.swift`
  — delete.
- `packages/desktop/Tests/AutopodClientTests/AnalyticsWiringTests.swift`
  — update any assertions tied to `.analyticsSection(_)` or to the
  placeholder text.

## Does not touch

- `packages/daemon/` — server-side untouched in this brief.
- `packages/shared/` — no shared types affected.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/` — drill / card
  contents are Brief 03's surface.
- `packages/desktop/Sources/AutopodClient/` — API surface unchanged.

## Constraints

From `design.md` → Seams: Brief 01 is independent of Briefs 02 and 03.
It can land before either. It must not introduce a new placeholder or a
"coming soon" surface — the rule from the spec is: unshipped phases are
invisible until they ship.

From `design.md` → Reference reading: the right-pane scene-state
contract from Phase 0 is preserved — the `AnalyticsRightPaneView` host
is unaffected, only how the sidebar selection routes to it changes.

## Test expectations

- **AnalyticsWiringTests.swift** — keep coverage for: clicking the
  Analytics sidebar row sets `sidebarSelection = .analytics`; the
  middle pane renders `AnalyticsView`; the detail pane renders
  `AnalyticsRightPaneView`. Drop tests that asserted the
  placeholder text or that walked through sub-sections.
- **No new test file needed** — the sidebar simplification is purely a
  delete/collapse operation; covered by updates to existing tests.
- **Manual eyeball:** open the app, verify the Analytics sidebar group
  has one row labelled "Analytics", clicking it opens Overview, the
  card grid still works, and no "ships in Phase N" string appears
  anywhere in the UI.

## Risks / pitfalls

- **`AnalyticsSection` may be re-exported.** Search the AutopodClient /
  AutopodUI module exports for any public surface — if it leaked
  outside the Models folder, deleting it could break a downstream
  consumer.
- **`SidebarItem` is `Hashable`.** Adding a new flat case without a
  payload is fine; removing the `analyticsSection(AnalyticsSection)`
  case may invalidate stored sidebar selections in any persisted
  state. Check if `sidebarSelection` is restored from `@AppStorage` /
  `SceneStorage`; if so, fall back to a default on decode failure.
- **`analyticsSelectPodResult` may have called sites in tests.**
  If it's exercised in `AnalyticsWiringTests` for routing, simplify
  rather than delete — the row-click handler in Brief 03 still needs a
  way to "open this pod with Summary tab focused" without losing the
  analytics scene state.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
