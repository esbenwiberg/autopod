---
title: "Build memory workbench and Analytics card"
touches:
  - packages/desktop/Sources/AutopodUI/Views/Memory/MemoryManagementView.swift
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/MemoryAnalyticsDrillView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
  - packages/desktop/Tests/AutopodUITests/MemoryWorkbenchTests.swift
  - packages/desktop/Tests/AutopodClientTests/AnalyticsWiringTests.swift
does_not_touch:
  - packages/daemon/
  - packages/escalation-mcp/
  - packages/desktop/Package.swift
---

## Task

Build the user-facing memory workbench and lightweight Analytics card. `MemoryManagementView` should become a two-pane workbench: pending candidates and active memories on the left; selected memory/candidate details, source evidence, usage history, stale/harmful evidence, and impact on the right. Preserve the existing manual create/edit/delete controls and the Analyze & Fix workspace entrypoint.

Add one lightweight `Memory` card to Analytics. The card summarizes memory-loop health. Its drill shows fleet-level selected/injected/read/applied/not_reported counts and repeated-pain deltas. Do not duplicate review/edit controls in Analytics.

## Touches

- `packages/desktop/Sources/AutopodUI/Views/Memory/MemoryManagementView.swift` - approved workbench layout.
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift` - add `.memory`.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` - add card data wiring.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift` - route to new drill view.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/MemoryAnalyticsDrillView.swift` - new drill.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` - pass load closures/store data.
- `packages/desktop/Tests/AutopodUITests/MemoryWorkbenchTests.swift` and `packages/desktop/Tests/AutopodClientTests/AnalyticsWiringTests.swift` - behavior tests.

## Does not touch

- `packages/daemon/` - APIs already exist.
- `packages/escalation-mcp/` - reporting already exists.
- `packages/desktop/Package.swift` - use existing test targets and SwiftUI primitives.

## Constraints

- Use the approved wireframe from `design.md`.
- Detailed action/evidence belongs in Memory. Analytics is a lightweight trend signal only.
- Stale/harmful evidence is shown as a warning/evidence panel; humans edit/delete manually. No auto-disable UI in v1.
- Correct stale marketing copy that claims semantic memory search.

## Test expectations

Cover view-model grouping of pending candidates and active memories, selected detail panel selection, impact panel values, stale/harmful warning state, Memory Analytics card selection, and right-pane drill routing.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
