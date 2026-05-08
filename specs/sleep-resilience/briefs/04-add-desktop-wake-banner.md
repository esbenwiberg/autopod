---
title: "Add desktop banner that surfaces host.resumed events"
depends_on: [01-add-sleep-detector]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodClient/Types/EventTypes.swift
  - packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift
  - packages/desktop/Sources/AutopodUI/Views/Shared/HostResumeBanner.swift
does_not_touch:
  - packages/daemon
  - packages/shared
---

## Task

Add a transient banner in the macOS desktop app that appears for ~5 s
when the daemon publishes a `host.resumed` event over the WebSocket.
Mirror the existing `WorktreeCompromisedBanner` style
(`packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift:25`)
but smaller and self-dismissing.

### Scope, in detail

**1. Decode the event.**

In `packages/desktop/Sources/AutopodClient/Types/EventTypes.swift`:

- Add a `case hostResumed(HostResumedInfo)` to the typed `SystemEvent`
  enum (around line 120).
- Define `HostResumedInfo`:

  ```swift
  public struct HostResumedInfo: Sendable, Equatable {
    public let sleptMs: Int
    public let detector: String              // "tick-gap" | "pmset" | "native"
    public let reconciledPodIds: [String]
  }
  ```

- Extend `SystemEvent.parse(_ raw: RawSystemEvent)` (around line 138) to
  recognise `type == "host.resumed"` and decode `sleptMs`, `detector`,
  and `reconciledPodIds` from the raw payload. If any required field is
  missing, return `nil` (skip the event).

**2. Surface to the UI store.**

In `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift`,
add a published property the UI can observe:

```swift
@Published public private(set) var lastHostResume: HostResumedInfo?
```

When a `hostResumed(info)` event arrives, set `lastHostResume = info`.
The store is the single source of truth — the banner observes the
property; resetting to `nil` after dismiss is the banner's job (or
add a `clearHostResume()` method).

**Buffering:** Brief 02 publishes `host.resumed` *twice* — once from
the detector with `reconciledPodIds: []`, once from pod-manager after
reconcile completes with the populated array. The UI can either:
- (a) Drop the empty event entirely (recognise `reconciledPodIds.isEmpty`
  AND `sleptMs > 0` as the initial event; wait briefly for the
  follow-up).
- (b) Show "Resumed after Xm" first, then update to "Resumed after Xm
  — N pods OK" when the second event lands.

Option (b) is simpler and more honest (the user gets immediate
feedback). Pick (b) unless it looks visually janky in practice.

**3. Render the banner.**

Create `packages/desktop/Sources/AutopodUI/Views/Shared/HostResumeBanner.swift`:

```
┌──────────────────────────────────────┐
│ Resumed after 4h 12m — 2 pods OK     │  ← capsule, soft accent color
└──────────────────────────────────────┘
```

- SwiftUI view that observes `EventStream.shared.lastHostResume` (or
  whatever the project's pattern is — match existing observers).
- Visible when `lastHostResume != nil`.
- Auto-dismiss after 5 s (use `.task` + `try? await Task.sleep(...)`
  or the project's `withDelay`-style helper if one exists).
- Click anywhere on the banner dismisses it.
- Format `sleptMs` as a friendly duration: under 1 min → "Xs", under
  1 hour → "Xm Ys" (drop seconds if `sleptMs > 5min`), 1 hour+ →
  "Xh Ym".
- Pluralise "pods" correctly (`1 pod OK`, `2 pods OK`).
- If `reconciledPodIds.isEmpty`, just show "Resumed after Xm".

**4. Mount the banner.**

The banner must appear at a window-level position so it's visible
regardless of which view the user is on. Likely candidates (the
executor reads the project to pick):

- The root `WindowGroup` content view in
  `packages/desktop/Sources/AutopodDesktop/`.
- An overlay / `.toolbar` / `.safeAreaInset` modifier on the main
  navigation container.

Match whatever pattern the existing banner uses (search for
`WorktreeCompromisedBanner` callers — they're scoped to a specific
detail view, which is *not* what we want here. The wake banner is
window-scoped.)

## Touches

- `packages/desktop/Sources/AutopodClient/Types/EventTypes.swift` — add
  case + parse logic.
- `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift` —
  surface property.
- `packages/desktop/Sources/AutopodUI/Views/Shared/HostResumeBanner.swift`
  (new) — banner view.

## Does not touch

- `packages/daemon` — the backend emits the event already (briefs 01
  and 02 own it).
- `packages/shared` — the type lives in shared but is owned by brief
  01.

## Constraints

- macOS-only. No Linux / Windows app code in this codebase to worry
  about.
- Don't modify backend or shared packages — those changes land in
  briefs 01 and 02. Coupling to those briefs is via the stable
  `host.resumed` event shape defined in `design.md` → Contracts.
- Match the project's SwiftUI conventions (look at adjacent views in
  `Views/Shared/` and `Views/Detail/`). Don't introduce new
  dependencies.
- The banner is informational, not interactive beyond dismiss. No
  buttons, no links, no menu.
- Mount at a level where the user always sees it — not inside a tab
  that might be backgrounded.

## Test expectations

N/A. This codebase has no Swift test harness configured for
`AutopodUI`. Verification is via:
- The diff reviewer reading `EventTypes.swift` to confirm parse logic.
- The reviewer mentally executing the UI flow.
- (Manual, optional) the user running the app and triggering a sleep
  cycle to see the banner.

If a test harness gets added later, the banner's `format(sleptMs:)`
helper is the testable seam — extract it as a static function in the
banner file.

## Risks / pitfalls

- The Swift codebase's published-property + observation pattern may
  not match SwiftUI's `@StateObject` / `@EnvironmentObject` /
  `@ObservableObject` defaults. Read at least two existing observer
  views in `Views/` before writing the banner — match the prevailing
  pattern (don't introduce Combine if the project uses Observation
  framework, or vice versa).
- `RawSystemEvent` parsing in `EventTypes.swift:105+` uses a custom
  init pattern. Adding a new case may require careful reading of the
  existing decoder's flow — don't break sibling cases.
- The buffering decision (option a vs b above) only matters if both
  events arrive within ~100 ms of each other. They will, in practice.
  Option (b) is fine; don't over-engineer.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings (Swift portions are
   reviewed manually since the project has no Swift linter wired into
   the validation pipeline).
2. Re-run build and tests for the rest of the workspace; both must
   still pass.
3. Commit and push.
