---
title: "Desktop fix-queue UI: chip + popover on PodCardFinal, toast on SpawnFixSheet"
depends_on: [03-update-spawn-fix-api]
acceptance_criteria:
  - type: cmd
    outcome: "test -f packages/desktop/Sources/AutopodUI/Views/Cards/FixQueuePopover.swift && grep -nE 'queueLength|FixQueuePopover' packages/desktop/Sources/AutopodUI/Views/Cards/PodCardFinal.swift → exit 0 — popover file exists and is wired into the pod card"
    hint: "test -f packages/desktop/Sources/AutopodUI/Views/Cards/FixQueuePopover.swift && grep -nE 'queueLength|FixQueuePopover' packages/desktop/Sources/AutopodUI/Views/Cards/PodCardFinal.swift"
    polarity: exit-zero
touches:
  - packages/desktop/Sources/AutopodUI/Views/Cards/PodCardFinal.swift
  - packages/desktop/Sources/AutopodUI/Views/Cards/FixQueuePopover.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/SpawnFixSheet.swift
  - packages/desktop/Sources/AutopodUI/Models/Pod.swift
  - packages/desktop/Sources/AutopodClient/Types/PodResponse.swift
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/desktop/Sources/AutopodUI/Views/Profiles/
  - packages/desktop/Sources/AutopodUI/Models/Profile.swift
---

## Task

Surface the feedback queue in the macOS desktop. The user needs to (a)
see at a glance that messages are queued for a parent pod's next fix
iteration, (b) inspect the queued messages to confirm what'll be sent,
and (c) get visual feedback when they submit via `SpawnFixSheet` that
the message was queued and where in the line it landed.

### Wireframe (approved during /plan-feature interview)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ● tragic-marsupial                                  merge_pending   │
│  Branch: feat/payments-redo                          PR #482         │
│                                                                      │
│  [ Fix iteration 2 ]  [ Queue 3 ▾ ]  [ View PR ]  [ Spawn fix… ]    │
│                            │                                         │
│                            ▼  click ─────────────────────┐           │
│                                                          │           │
│                            ┌─────────────────────────────┘           │
│                            │  Queued for next iteration              │
│                            │  ─────────────────────────              │
│                            │  • Address SAST finding #14   2m ago    │
│                            │  • Reviewer: rename foo→bar   8m ago    │
│                            │  • Reviewer: simplify branch  9m ago    │
│                            │                                         │
│                            │  Drains when current fix pod completes  │
│                            └─────────────────────────────────────────│
```

This is the spec for what the user sees. Reviewer judges fidelity to
this wireframe before greenlighting the brief.

### Model + decoder

- **`Sources/AutopodUI/Models/Pod.swift`** — add
  `let queueLength: Int` (default 0). The existing struct already has
  several optional Ints (e.g. `fixIteration`); follow the same shape but
  treat `queueLength` as non-optional with a 0 default — the daemon
  always sends it (brief 02's pod serialiser).
- **`Sources/AutopodClient/Types/PodResponse.swift`** — decode
  `queueLength: Int` from the JSON. Use
  `try container.decodeIfPresent(Int.self, forKey: .queueLength) ?? 0`
  so older daemon builds (mid-rollout) decode cleanly.

### Chip on the pod card

- **`Sources/AutopodUI/Views/Cards/PodCardFinal.swift`** — in the chip
  `HStack` around line 213, add a new chip immediately after the
  existing "Fix iteration N" chip:

  ```swift
  if pod.queueLength > 0 {
      QueueChip(count: pod.queueLength) {
          showQueuePopover.toggle()
      }
      .popover(isPresented: $showQueuePopover, arrowEdge: .top) {
          FixQueuePopover(podId: pod.id)
      }
  }
  ```

  `QueueChip` is a small SwiftUI view local to this file (match the
  styling of the existing `FixIterationChip` / equivalent — same
  capsule background, same font size). The chevron-down (`▾`) is part
  of the chip's label.

- The chip is hidden when `queueLength == 0`. No greyed-out state.

### `FixQueuePopover` view

- **`Sources/AutopodUI/Views/Cards/FixQueuePopover.swift`** *(new)* —
  popover that:
  1. On appear, fetches `GET /pods/:podId/fix-feedback` (a new endpoint
     this brief does NOT add — see "Out of scope" below). For this brief
     the popover reads from a sibling field on the `Pod` payload OR uses
     the WebSocket pod-update event.

     **Decision**: lean on the WebSocket pod-update event. Extend the
     daemon's pod-serialiser (in brief 02 — already in its
     does-not-touch but the WS payload IS owned by 02) to include the
     last N messages (N = 10) as `recentQueueMessages: [{message,
     createdAt}]`. The chip stays driven by `queueLength`; the popover
     reads `recentQueueMessages`. *If brief 02's reviewer doesn't want
     to expand the WS payload, this brief gets a follow-up to add the
     fetch endpoint.* Coordinate via the gate-3 review.
  2. Renders the wireframe layout: a header (`Queued for next
     iteration`), a divider, a list of bullet rows showing message text
     truncated to one line + relative timestamp ("2m ago"). Use Swift's
     `RelativeDateTimeFormatter` for the timestamp.
  3. Footer line: `Drains when current fix pod completes`.
  4. No edit / delete affordances. Append-only.
  5. Width: ~360pt. Max height: 320pt with scroll.

### `SpawnFixSheet` toast

- **`Sources/AutopodUI/Views/Detail/SpawnFixSheet.swift`** — after the
  user submits, decode the response as `SpawnFixResponse` (typed from
  the shared types — brief 01 exports this). On `ok: true`, dismiss the
  sheet and show a brief green toast on the pod card:
  `Queued · position \(queueLength)`.

  Use the existing toast pattern in the desktop if one exists; if not,
  a minimal `.overlay(alignment: .top)` with an opacity animation
  works. Reuse rather than create a heavyweight notification system.

  On `ok: false` (`reason: 'parent_terminal'`), show an error alert
  inside the sheet without dismissing.

### Out of scope (handover to next brief if needed)

- No new HTTP endpoint for queue inspection. The popover reads from the
  pod-update WS payload that brief 02 emits. If that turns out to be
  insufficient at review time, a follow-up brief adds a dedicated
  `GET /pods/:podId/fix-feedback` route.
- No edit / delete UI on queued messages. The queue is append-only by
  design (ADR-025).
- No multi-pod overview of queues. The chip lives per-pod on
  `PodCardFinal`.

## Test expectations

- `xcodebuild -scheme AutopodUI -destination 'platform=macOS' build`
  must succeed.
- The reviewer is the validation anchor for the rendered chip and
  popover — no `web` AC is possible against native macOS. The wireframe
  in this brief is the spec; reviewer judges fidelity.
- Optional: add a SwiftUI snapshot test for `FixQueuePopover` at three
  states (1 message, 3 messages, 0 messages = hidden). Snapshot tests
  are not required but they make regression review fast. Use the
  existing snapshot harness if `packages/desktop` has one; do not
  introduce a new harness for this brief alone.
- Behavioural anchor: the SpawnFixSheet → toast flow is exercised by
  the reviewer manually (`Spawn fix` button → message → submit →
  observe toast + chip count bump).
- The chip's count is reactive to WebSocket pod-update events. Confirm
  by spawning a fix scenario where the chip count changes without
  manual refresh.
