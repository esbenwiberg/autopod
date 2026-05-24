---
title: "Mirror memory APIs in desktop client"
touches:
  - packages/desktop/Sources/AutopodClient/Types/Memory.swift
  - packages/desktop/Sources/AutopodClient/Types/MemoryAnalyticsResponse.swift
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodClient/Types/EventTypes.swift
  - packages/desktop/Sources/AutopodDesktop/Stores/MemoryStore.swift
  - packages/desktop/Tests/AutopodClientTests/MemoryResponseTests.swift
  - packages/desktop/Tests/AutopodClientTests/MemoryStoreTests.swift
does_not_touch:
  - packages/desktop/Sources/AutopodUI/Views/Memory/MemoryManagementView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/
  - packages/daemon/
---

## Task

Mirror the daemon memory contracts in Swift and wire the client/store layer. Add Codable types for extended `MemoryEntry`, candidates, source evidence, usage history, stale/harmful evidence, and `MemoryAnalyticsResponse`. Add DaemonAPI methods for candidate review and analytics. Extend `MemoryStore` to load pending candidates, active memories, selected details, usage/evidence, and the Analytics card payload.

## Touches

- `packages/desktop/Sources/AutopodClient/Types/Memory.swift` - extend existing memory types while preserving legacy `createdBySessionId` compatibility.
- `packages/desktop/Sources/AutopodClient/Types/MemoryAnalyticsResponse.swift` - new analytics mirror.
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` - add memory candidate/evidence/analytics calls.
- `packages/desktop/Sources/AutopodClient/Types/EventTypes.swift` - decode candidate events.
- `packages/desktop/Sources/AutopodDesktop/Stores/MemoryStore.swift` - state and methods for the new workbench.
- `packages/desktop/Tests/AutopodClientTests/MemoryResponseTests.swift` and `packages/desktop/Tests/AutopodClientTests/MemoryStoreTests.swift` - Codable/store tests.

## Does not touch

- `packages/desktop/Sources/AutopodUI/Views/Memory/MemoryManagementView.swift` - layout comes in brief 08.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/` - card/drill comes in brief 08.
- `packages/daemon/` - API already exists.

## Constraints

- Keep existing approve/reject/edit/delete behavior working.
- Decode legacy entries with missing metadata.
- Treat unknown future enum cases conservatively where Swift allows it.

## Test expectations

Cover decoding legacy memory entries, decoding extended entries, decoding candidates, decoding usage history, decoding memory analytics, DaemonAPI path construction, and MemoryStore event handling.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
