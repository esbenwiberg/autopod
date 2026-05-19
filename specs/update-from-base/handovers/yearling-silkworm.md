# Handover — yearling-silkworm (brief 03: desktop Update From Base button)

## What was built

Added the **Update From Base** button to the desktop Validation tab. The button
appears for `validating`, `failed`, and `reviewRequired` pods, is disabled when
the pod has no worktree or a compromised worktree, and is disabled while the
request is in flight.

### Files changed

- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift`
  - Added `UpdateFromBaseResponse` struct (public, Codable, Sendable)
  - Added `updateFromBase(_ id: String) async throws -> UpdateFromBaseResponse`
    — custom HTTP method that handles 409 dual semantics (conflict vs INVALID_STATE)

- `packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift`
  - Added `updateFromBase(_ podId:) async -> UpdateFromBaseResponse?`
  - Calls `podStore.refreshSession` only on `rebased` and `queued_after_abort`
  - Wired into the `actions` computed property

- `packages/desktop/Sources/AutopodUI/Models/PodActions.swift`
  - Added `updateFromBase: @MainActor @Sendable (String) async -> UpdateFromBaseResponse?`
  - Default no-op `{ _ in nil }` for previews

- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift`
  - Two new `@State` vars: `isUpdatingFromBase: Bool`, `updateFromBaseMessage: String?`
  - `.onChange(of: pod.status)` clears the message on status transition
  - Button inserted between Skip Validation and Interrupt (for validating), and
    before Force Approve (for failed/reviewRequired)
  - `updateFromBaseMessage` displayed as a `.caption` text after the HStack via
    `@ViewBuilder` sibling — no VStack wrapper needed
  - `updateFromBaseLabel(_ response:)` maps response action to display string

## Response type

```swift
public struct UpdateFromBaseResponse: Codable, Sendable {
  public let ok: Bool
  public let action: String  // "queued_after_abort" | "already_up_to_date" | "rebased" | "conflict"
  public let baseBranch: String?
  public let validation: String?  // "started"
  public let conflicts: [String]?
}
```

## Key design decisions

### 409 dual semantics

The daemon returns 409 for both the typed conflict outcome and INVALID_STATE
errors. The standard `request<T>()` helper in DaemonAPI cannot handle this
because it throws immediately on 409. The `updateFromBase` method duplicates the
request boilerplate and inspects the body before deciding to return or throw:
- `action == "conflict"` → decode and return as typed result
- Any other 409 → throw `DaemonError.serverError(409, msg)`

### Result messaging

The `updateFromBaseMessage` is displayed as a `@ViewBuilder` sibling view after
the HStack, not in a VStack wrapper. SwiftUI's `@ViewBuilder` supports sibling
views; the parent `VStack(alignment: .leading, spacing: 0)` sees the TupleView
from `headerView` as a single padded child. The message clears on `pod.status`
change.

### Refresh on action

Only `rebased` and `queued_after_abort` trigger `refreshSession`. The other two
outcomes don't change pod status:
- `already_up_to_date` → pod unchanged
- `conflict` → pod stays in failed/reviewRequired

## Files owned (do not modify without reason)

All four files listed above. The `UpdateFromBaseResponse` type lives in
`DaemonAPI.swift` (not in `AutopodUI`) to co-locate it with the request method.

## Constraints for downstream pods

- This is brief 03 (desktop). There is no brief 04 in the update-from-base series.
- The Swift code cannot be compiled in this Linux container — it must be built
  and smoke-tested by a human reviewer on macOS using Xcode.
- The JS/TypeScript build and all 2693 tests pass on the TypeScript packages
  (daemon, CLI, shared, etc.).

## Deviations from brief

None. Button placement, visibility conditions, disable conditions, and result
message strings match the brief exactly.
