---
title: "Render setup in desktop validation UI"
touches:
  - packages/desktop/Sources/AutopodClient/Types/EventTypes.swift
  - packages/desktop/Sources/AutopodClient/Types/ValidationResponse.swift
  - packages/desktop/Sources/AutopodUI/Models/Pod.swift
  - packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift
  - packages/desktop/Sources/AutopodUI/Views/Features/FeatureOverviewView.swift
  - packages/desktop/Tests/AutopodClientTests/PodMapperTests.swift
  - packages/desktop/Tests/AutopodUITests/ValidationProgressTests.swift
does_not_touch:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/escalation-mcp/
---

## Task
Render Setup as the first blocking validation phase in Desktop. Decode setup
events/results, track setup state/output in the UI model, add the Setup chip
before Lint, and show setup failure details with downstream phases gray/skipped.

## Touches
Update event/validation response DTOs, Pod validation model, mapper, Validation
tab rendering, feature overview copy, and desktop tests where practical.

## Does not touch
Do not change daemon validation behavior or MCP behavior in this brief.

## Constraints
Setup is a normal blocking validation phase, not advisory. It counts in the
visible phase row and status model. Historical validation attempts without setup
data must still render correctly.

## Test expectations
Add or update desktop decode/map/model tests where possible, but keep
Autopod-self required facts empty because Linux pods cannot run macOS/Xcode
desktop tests.

## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Run local macOS Swift/Xcode validation if available.
3. Commit and push.
