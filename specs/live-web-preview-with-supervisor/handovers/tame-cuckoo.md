# Handover: tame-cuckoo (brief 02 — render-preview-card)

## What was built

Added the Preview card to `OverviewTab.swift` and wired all required model/networking
layers. Operators can now see live dev server status (Running / Restarting / Stopped)
for any `hasWebUi=true` pod and click "Open live app" to open the running app in their
default browser.

### Files owned by this brief (do not modify without good reason)

- `packages/desktop/Sources/AutopodUI/Models/PreviewPoller.swift` *(new)* — `@Observable @MainActor` polling helper
- `packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift` — PreviewCard, polling lifecycle
- `packages/desktop/Sources/AutopodUI/Models/Pod.swift` — `hasWebUi: Bool` property
- `packages/desktop/Sources/AutopodUI/Models/MockData.swift` — `runningWithWebUi`, `restartingWithWebUi`, `stoppedWithWebUi` fixtures
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` — `PreviewStatus` struct + `previewStatus(podId:)` method
- `packages/desktop/Sources/AutopodClient/Types/PodResponse.swift` — `hasWebUi: Bool?` on `SessionResponse`
- `packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift` — `hasWebUi` propagation
- `packages/desktop/Tests/AutopodUITests/PreviewPollerTests.swift` *(new)* — 5 unit tests for PreviewPoller
- `packages/desktop/Tests/AutopodClientTests/PodMapperTests.swift` — 3 tests for `hasWebUi` mapping

### Threading chain also touched (required for production wiring)

- `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift` — passes `loadPreviewStatus` to OverviewTab
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` — passes `loadPreviewStatus` to DetailPanelView
- `packages/desktop/Sources/AutopodDesktop/Views/AppRootView.swift` — provides `loadPreviewStatus` closure calling `api.previewStatus(podId:)`

## Contracts / interfaces

### `PreviewStatus` (in `AutopodClient`)

```swift
public struct PreviewStatus: Decodable, Sendable {
    public let running: Bool
    public let reachable: Bool
    public let restartCount: Int
    public let lastError: String?
    public let previewUrl: String?
}
```

This mirrors the JSON contract from brief 01's `GET /pods/:podId/preview/status`.

### `Pod.hasWebUi: Bool`

Added after `containerUrl`. Defaults to `false` when `SessionResponse.hasWebUi` is
nil (back-compat with older daemons).

### `loadPreviewStatus` closure type

```swift
((String) async throws -> PreviewStatus)?
```

Threaded through `MainView` → `DetailPanelView` → `OverviewTab`. Optional with
default `nil` so all existing callsites (previews, tests) don't need updating.

## Deviations from brief

1. **Timer.publish (Combine) → Task.sleep (async/await):** Brief specified Combine
   timer; no Combine exists in the codebase. Used `Task.sleep(for: .seconds(5))` in
   a polling loop inside `PreviewPoller`. Functionally identical; no new dependency.

2. **Actual file locations differ from brief:** DaemonAPI is in `AutopodClient/`
   (not `AutopodDesktop/Networking/`). `SessionResponse` is the DTO (not `PodResponse`).
   The brief's file paths described intent, not actual paths.

3. **Extra files touched:** `DetailPanelView`, `MainView`, `AppRootView` were not in
   the brief's expected-file list but are required to wire `loadPreviewStatus` from
   the network layer to the view.

## Discovered constraints / landmines

- **Module hierarchy:** `AutopodClient` ← `AutopodUI` ← `AutopodDesktop`. Any type
  visible in `OverviewTab` must live in `AutopodClient` or `AutopodUI`. `PreviewStatus`
  therefore lives in `AutopodClient`, not `AutopodUI`.
- **`Pod` init has two overloads.** The back-compat `outputMode` init delegates to
  the primary init via `self.init(...)`. When adding parameters to the primary init,
  ensure the back-compat overload still compiles (it does — `hasWebUi` has a default
  of `false`).
- **Swift 6 strict concurrency.** The `pollTask` closure uses
  `Task { @MainActor [weak self] in ... }` to avoid actor-crossing issues. The `load`
  closure is declared `@escaping (String) async throws -> PreviewStatus` (no
  `@Sendable` annotation) matching the existing `loadQuality` closure pattern.
- **`ActionHandler` was not touched** per brief constraint. `openLiveApp(podId:)`
  already existed at `ActionHandler.swift:489–497`; the card calls it via
  `actions.openLiveApp(pod.id)` where `actions` is the existing `PodActions` value.
