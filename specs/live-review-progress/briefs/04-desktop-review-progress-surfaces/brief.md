---
title: "Render structured live review progress"
touches:
  - packages/desktop/Sources/AutopodUI/Views/Cards/PodCardFinal.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/LiveReviewProgressView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shared/ActivityFeedList.swift
  - packages/desktop/Tests/AutopodUITests/ValidationProgressTests.swift
  - packages/desktop/Tests/AutopodUITests/ReviewCouncilTests.swift
  - packages/desktop/Tests/review-progress-contract.mjs
does_not_touch:
  - packages/daemon/
  - packages/desktop/Sources/AutopodUI/Views/Detail/ReviewCouncilView.swift
  - packages/mobile-web/
---

## Task

Render Option B on the existing macOS surfaces: a compact validating-card status, a structured
live Review panel with five human-named axes, and a grouped activity row whose disclosure contains
the raw safe snapshot state. Transition visibly through synthesis, closure when applicable, and
finalizing.

## Touches

- Validating state in PodCardFinal.
- Running Review branch in ValidationTab.
- New live-only Review progress component.
- Activity-feed grouping.
- Presentation tests and the Linux source contract.

## Does not touch

- Completed ReviewCouncilView behavior or findings.
- Other validation phase layouts.
- Mobile web.

## Constraints

- Use `N/5 settled`; unavailable axes show warning state and never count as completed.
- Show actual elapsed and configured guardrail, not percentage or ETA.
- Card remains compact and does not duplicate the detailed panel.
- Activity collapses repetitive council snapshots to the latest row while full logs retain every event.
- Preserve accessibility labels and reduced-motion behavior.

## Test expectations

- Pure presentation helpers cover axes, unavailable state, stages, and card copy.
- Focused Swift tests run locally on macOS.
- Human review compares all three surfaces with the approved wireframes.

## Wrap-up

Report automated verification and visual human-review status separately.
