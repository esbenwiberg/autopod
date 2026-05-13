---
title: "Render Preview card on pod overview tab"
depends_on:
  - 01-supervise-preview-server
touches:
  - packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift
  - packages/desktop/Sources/AutopodDesktop/Networking/DaemonAPI.swift
  - packages/desktop/Sources/AutopodDesktop/Models/PodResponse.swift
  - packages/desktop/Sources/AutopodUI/Models/Pod.swift
  - packages/desktop/Sources/AutopodDesktop/Stores/PodMapper.swift
  - packages/desktop/Sources/AutopodUI/MockData.swift
does_not_touch:
  - packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift
  - packages/daemon/
  - packages/shared/
  - packages/cli/
---

## Task

Add a Preview card to the macOS app's `OverviewTab` and wire it to the
endpoints brief 01 ships.

### Card placement

Slot the card into `OverviewTab.swift` between the Profile metadata
section and the Artifacts section. Preserve all existing section
ordering — do not move other cards.

### Card layout (approved wireframe in `design.md` → "UX flows")

```
┌─ Preview ────────────────────────────┐
│ ● Running           restarts: 0      │
│ http://127.0.0.1:17668   [ copy ]   │
│ [ ▶  Open live app ]                 │
└──────────────────────────────────────┘
```

States — render based on `previewStatus.running` and
`previewStatus.reachable` from the new endpoint:

- **● Running** (green dot) — `running && reachable`. Hide restart
  count when `0`; show muted when `> 0`.
- **◐ Restarting** (amber dot) — `running && !reachable`. Always show
  restart count. Subtitle: "Server unreachable, supervisor respawning".
- **○ Stopped** (muted dot) — `!running`. Subtitle: "No preview active".
- **Hidden** — `pod.hasWebUi != true`. Card not rendered at all.

The "Open live app" button is enabled in all three visible states. It
calls the **existing** `ActionHandler.openLiveApp(podId)` action
(`packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift:489–497`)
which already calls `api.startPreview(podId)` then opens the URL. That
file is in `does_not_touch` — the action body doesn't change; this
brief just wires it to a button that didn't exist before.

The previewUrl line is a click-to-copy field. Use the existing pattern
in `OverviewTab.swift` for copy fields (look for `Copy to clipboard` /
`NSPasteboard`).

### Polling

Card mounts → fetch `preview/status` immediately, then every 5s while
`pod.status` is one of `running`, `validating`, `validated`,
`awaiting_input`, `paused`. Stop polling within one tick when
`pod.status` becomes `complete`, `killed`, or `failed`. Stop polling on
view disappear.

Use `Timer.publish(every: 5, on: .main, in: .common).autoconnect()`
inside an `onAppear` / `onDisappear` pair. Make sure the cancellable is
stored on the view's `@State` and torn down on disappear — a leaked
ticker is the most likely regression here.

### Networking

Add `previewStatus(podId: String)` to `DaemonAPI.swift`:

```swift
struct PreviewStatus: Decodable {
    let running: Bool
    let reachable: Bool
    let restartCount: Int
    let lastError: String?
    let previewUrl: String?
}

func previewStatus(podId: String) async throws -> PreviewStatus
```

`GET /pods/:podId/preview/status`. Auth: same bearer-token plumbing as
the rest of `DaemonAPI`.

### Model surface

- `PodResponse.swift` — decode the new `hasWebUi: Bool` field from the
  daemon DTO. Default to `false` if absent (defensive against an older
  daemon).
- `Pod.swift` (UI model) — add `hasWebUi: Bool`.
- `PodMapper.swift` — propagate the field from DTO to UI model.
- `MockData.swift` — add fixtures: `runningWithWebUi`,
  `restartingWithWebUi`, `stoppedWithWebUi`, `running` (existing,
  hasWebUi=false → card hidden).

### Why

The user-facing outcome of this spec ("operator can see the running app
before approval") is gated on this card. The plumbing already exists
on both ends — `startPreview`/`stopPreview` on the daemon, the
dangling `openLiveApp` action on the desktop — but no view ever calls
the action, so the operator has no way to trigger preview today. This
brief is the wire.

`hasWebUi` is read from the pod row brief 01 populates (no second
profile fetch). Workspace pods get the same card because their
container persists for user interaction — they want this even more than
agent pods do.

### Constraints

- **Do NOT modify `ActionHandler.openLiveApp`.** The action body is
  correct as-is; this brief only wires it to a button.
- **Do NOT poll once the pod is terminal.** Leaking a 5s timer on a
  closed pod page is the easiest way to ship a regression.
- **Card hidden when `hasWebUi=false`.** No "card with N/A state" — just
  don't render it. The space goes back to its neighbours.
- **No new networking layer.** Use the existing `DaemonAPI` patterns
  (auth, JSON decoding, error mapping). Don't introduce a separate
  client.

### Test expectations

- SwiftUI Preview: `OverviewTab` renders correctly with each
  `MockData` fixture — running, restarting (with restart-count chip),
  stopped, hidden.
- Swift unit (`PodMapperTests` or similar — match existing convention):
  `PodMapper` propagates `hasWebUi` from `PodResponse` to `Pod`. Both
  `true`, `false`, and missing-field-defaults-to-false cases.
- Swift unit on the polling timer: when `pod.status` transitions to
  `complete`, the polling cancellable is torn down within one tick.
  (May require lifting the polling logic into a small testable
  `@Observable` helper rather than inlining in the view body.)
- **Manual smoke (record in PR body):** spawn a teamplanner-agent pod,
  watch the Preview card go Running → Restarting (after `kill -9` of the
  dev server PID inside the container) → Running, click "Open live
  app", verify the browser opens to `previewUrl` and the page loads.

### Verification

Zero firing acceptance criteria — desktop is a native SwiftUI binary;
autopod's validation pipeline has no Playwright / AppleScript /
accessibility target for it. Verification is SwiftUI Previews + the
swift unit tests above + the recorded manual smoke. Same shape as
brief 01 and `specs/redact-spawn-log-task/brief.md`.
