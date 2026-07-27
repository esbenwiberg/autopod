---
title: "Render unavailable quality telemetry honestly"
touches:
  - packages/desktop/Sources/AutopodClient/Types/PodQualitySignals.swift
  - packages/desktop/Sources/AutopodClient/Types/PodQualityScore.swift
  - packages/desktop/Sources/AutopodUI/Views/Shared/StatTile.swift
  - packages/desktop/Sources/AutopodUI/Views/Shared/SessionQualityCard.swift
does_not_touch:
  - packages/daemon/
  - packages/desktop/Sources/AutopodUI/Views/Analytics/
---

## Task

Consume quality telemetry availability in the native desktop and render unavailable inspection-dependent values neutrally. Keep the existing Session Quality card layout and preserve measured values when telemetry is available.

## Touches

- `packages/desktop/Sources/AutopodClient/Types/PodQualitySignals.swift`
- `packages/desktop/Sources/AutopodClient/Types/PodQualityScore.swift`
- `packages/desktop/Sources/AutopodUI/Views/Shared/StatTile.swift`
- `packages/desktop/Sources/AutopodUI/Views/Shared/SessionQualityCard.swift`

## Does not touch

- `packages/daemon/`
- `packages/desktop/Sources/AutopodUI/Views/Analytics/`

## Constraints

Follow convention-001: Autopod-self required facts run in the Linux pod, so macOS SwiftUI/AppKit validation belongs in human review unless a pure cross-platform test is available. Do not add a macOS-only required-fact command.

Do not render unavailable values as numeric zero, red health, or a numeric score badge. Reuse the card's established `—` and neutral-state conventions; do not rearrange the screen.

## Test expectations

Add pure-model coverage only if it executes in the Linux pod. Otherwise keep implementation small and rely on the daemon contract facts plus the narrow native human-review criterion. Verify available values retain their current formatting and unavailable values have explanatory help text.

## Wrap-up

Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
