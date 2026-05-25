---
title: "Render Advisory QA tab"
touches:
  - packages/desktop/Sources/AutopodClient/Types/ValidationResponse.swift
  - packages/desktop/Sources/AutopodUI/Models/Pod.swift
  - packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift
  - packages/desktop/Tests/AutopodClientTests/PodMapperTests.swift
does_not_touch:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/shared/src/types/validation.ts
---

## Task
Render advisory browser QA results in the desktop Validation tab. Add a neutral
`Advisory QA` chip after `Review`; selecting it opens an advisory detail panel
showing complete/skipped/error status, observation notes, verdicts, and
screenshots.

## Touches
Update validation response DTOs, UI models, mapper, ValidationTab rendering, and
desktop mapper tests.

## Does not touch
Do not change daemon validation behavior in this brief.

## Constraints
Advisory QA is not a validation phase. It must not affect phase counts,
`allPassed`, validation summary color, or failure wording.

## Test expectations
Cover decode/map behavior and the model-level exclusion from phase counts.
Manual/human review covers the SwiftUI layout.

## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
