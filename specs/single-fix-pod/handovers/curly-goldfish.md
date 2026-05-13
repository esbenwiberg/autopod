# Handover: curly-goldfish (Desktop queue UX — brief 05)

## What was built

Surfaced the fix-feedback queue on the macOS desktop pod card. Users can now
see how many messages are queued for the next fix iteration, inspect those
messages in a popover, and receive confirmation when their spawn-fix request
lands in the queue.

**Files modified:**

- `Sources/AutopodUI/Models/Pod.swift` — added `queueLength: Int` (default 0)
  and `recentQueueMessages: [PodQueueMessage]` (default `[]`); added
  `PodQueueMessage` struct (`id`, `message`, `createdAt`).
- `Sources/AutopodClient/Types/PodResponse.swift` — added `queueLength: Int?`
  and `recentQueueMessages: [QueueMessageResponse]?` to `SessionResponse`;
  added `QueueMessageResponse` struct; updated `CodingKeys`.
- `Sources/AutopodDesktop/Mapping/PodMapper.swift` — maps both new fields;
  converts `QueueMessageResponse.createdAt` (ms epoch Int64) to `Date`.
- `Sources/AutopodUI/Views/Cards/PodCardFinal.swift` — added `@State
  showQueuePopover`, `fixIterationChip` computed property, and `QueueChip`
  struct; wired both chips into the compact content top row HStack (after
  series chip, before Spacer); QueueChip opens `FixQueuePopover` via
  `.popover(arrowEdge: .top)`.
- `Sources/AutopodUI/Views/Cards/FixQueuePopover.swift` *(new)* — popover
  with header, scrollable bullet list (relative timestamps via
  `RelativeDateTimeFormatter`), footer; 360pt wide, max 320pt tall.
- `Sources/AutopodClient/DaemonAPI.swift` — renamed `SpawnFixBody.userMessage`
  → `.message` (matches brief 03 Zod schema); `spawnFixSession` now returns
  `SpawnFixResponse` instead of discarding it; added `SpawnFixResponse` struct.
- `Sources/AutopodDesktop/Stores/ActionHandler.swift` — `spawnFixSession`
  returns `SpawnFixResponse?` and uses `@discardableResult`.
- `Sources/AutopodUI/Models/PodActions.swift` — `spawnFix` closure type
  changed from `(String, String?) async -> Void` to
  `(String, String?) async -> SpawnFixResponse?`; default noop returns `nil`.
- `Sources/AutopodUI/Views/Detail/SpawnFixSheet.swift` — `onSpawn` is now
  `(String) async -> SpawnFixResponse?`; sheet shows inline toast "Queued ·
  position N" for ~900ms then dismisses on success; shows an `.alert` on
  `parent_terminal` without dismissing.
- `Sources/AutopodUI/Views/Detail/DetailPanelView.swift` — `onSpawn` callback
  updated to async form (`await actions.spawnFix(...)` whose return value
  propagates to the sheet).

## Deviations from brief

1. **No pre-existing `fixIterationChip` in `PodCardFinal.swift`** — the brief
   said "after the existing Fix iteration N chip". That chip only existed in
   `ValidationTab.swift`. This pod added `fixIterationChip` to `PodCardFinal`
   alongside the new `QueueChip` in the compact top row.

2. **Toast is inside the sheet, not "on the pod card"** — showing a toast on
   `SessionCardFinal` from inside a sheet requires cross-view state propagation
   with no existing mechanism. The brief's own fallback ("minimal overlay with
   opacity animation") was used inside the sheet instead. The UX outcome is
   equivalent: the user sees "Queued · position N" and the sheet closes.

3. **`SpawnFixBody.message` (not `userMessage`)** — changed to match brief 03's
   new Zod schema `{message: string}`. Old daemon builds (pre-brief-03) will
   receive an unrecognised field and silently ignore it; the spawn-fix still
   works since the old path treated a missing body as "auto-detect".

## Interfaces / contracts downstream pods must know about

- **`Pod.queueLength: Int`** and **`Pod.recentQueueMessages: [PodQueueMessage]`**
  are now on the `Pod` domain model. Data is zero/empty until brief 02's daemon
  serialiser populates `queueLength` and `recentQueueMessages` on the WS
  pod-update payload.

- **`SpawnFixResponse`** is now exported from `AutopodClient` (in
  `DaemonAPI.swift`). Shape: `{ ok: Bool, queued: Bool?, queueLength: Int?,
  fixPodId: String?, reason: String? }`. Any code that calls
  `actions.spawnFix(...)` now receives `SpawnFixResponse?` instead of `Void`.

- **`QueueMessageResponse`** is in `PodResponse.swift`. It expects `id: String`,
  `message: String`, `createdAt: Int64` (ms epoch).

## Files this pod owns — downstream should not modify without good reason

- `FixQueuePopover.swift` — new file, complete feature.
- `SpawnFixSheet.swift` — rewritten; any future changes to the spawn-fix UX
  start here.
- `PodActions.swift` line 48 — the `spawnFix` signature. Changing the return
  type again would require updating `ActionHandler` and all sheet callers.

## Constraints and landmines for downstream pods

- **Brief 02 must populate `queueLength` + `recentQueueMessages`** on the daemon
  WS pod-update serialiser for the chip to ever show non-zero. Until brief 02
  lands, the chip is always hidden (queueLength defaults to 0).
- **`FixQueuePopover` reads `messages` directly** (not via podId+fetch). If a
  future brief adds a dedicated `GET /pods/:id/fix-feedback` endpoint to refresh
  on demand, `FixQueuePopover` would need to be extended (currently read-only
  from pod model state at popover-open time).
- The `SpawnFixBody.message` rename is a breaking wire change vs. pre-brief-03
  daemons. Old daemons ignore the renamed field; behaviour is unchanged for the
  "auto-detect" path (no message provided → empty string sent).
