---
title: "Carry review progress into desktop state"
touches:
  - packages/desktop/Sources/AutopodClient/Types/PodResponse.swift
  - packages/desktop/Sources/AutopodClient/Types/EventTypes.swift
  - packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift
  - packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift
  - packages/desktop/Sources/AutopodDesktop/Stores/PodStore.swift
  - packages/desktop/Sources/AutopodUI/Models/Pod.swift
  - packages/desktop/Tests/review-progress-contract.mjs
  - packages/desktop/Tests/AutopodClientTests/ReviewProgressStateTests.swift
does_not_touch:
  - packages/desktop/Sources/AutopodUI/Views/
  - packages/daemon/
---

## Task

Decode `pod.review_progress` and the hydrated review snapshot into a single Swift domain model.
Apply live events through PodStore, preserve newer streamed state across REST refresh races, clear
terminal Review state correctly, and project each full snapshot into safe expandable activity
evidence.

## Touches

- Client wire DTOs and typed event parsing.
- REST-to-domain mapping.
- EventStream and PodStore state transitions.
- ValidationProgress review snapshot state.
- Focused native tests plus a Linux-executable source contract check.

## Does not touch

- SwiftUI card, Review panel, or activity-feed layout.
- Daemon contracts.

## Constraints

- One snapshot model serves live events and cold hydration.
- Newer WebSocket state must not regress to an older REST snapshot.
- Projected activity uses a stable review-council marker and contains no reviewer output.
- Keep backward compatibility with daemons that omit the additive fields.

## Test expectations

- Decode all stages and all axis statuses.
- Prove unavailable contributes to settled but not completed.
- Prove live state wins a stale hydration race.
- Run focused Swift tests locally; keep Linux required evidence honest per convention-001.

## Wrap-up

Report the wire/domain mapping and both verification results separately.
