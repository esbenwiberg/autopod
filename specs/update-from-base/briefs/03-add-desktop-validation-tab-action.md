---
title: "Add desktop Validation-tab Update From Base action"
depends_on: [01-add-daemon-update-from-base-action]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift
  - packages/desktop/Sources/AutopodUI/Models/PodActions.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift
  - packages/desktop/Sources/AutopodUI/Models/Pod.swift
  - packages/desktop/Sources/AutopodUI/Preview Support/MockData.swift
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/cli/
  - packages/escalation-mcp/
---

## Task

Add an `Update From Base` button to the desktop Validation tab only. It should
call the daemon action from brief 01, show loading/disabled states, and surface
the typed result without introducing a new screen.

Approved v1 wireframe:

```
Validation tab header

Attempt 2 of 3                                      [Open App]
                                                    [Skip Validation]
                                                    [Update From Base]
                                                    [Interrupt]

For failed / review_required:

Attempt 3 of 3                                      [Update From Base]
                                                    [Force Approve]
```

## API DTO

Add a Swift response type matching the daemon union:

```swift
public enum UpdateFromBaseResponse: Decodable, Sendable {
  case queuedAfterAbort
  case alreadyUpToDate(baseBranch: String)
  case rebased(baseBranch: String)
  case conflict(baseBranch: String, conflicts: [String])
}
```

The actual implementation may use a struct with `action`, `ok`,
`baseBranch`, `validation`, and `conflicts` fields if that better matches
existing `DaemonAPI.swift` style. The important contract is exact decoding of
the daemon response variants.

Add:

```swift
public func updateFromBase(podId: String) async throws -> UpdateFromBaseResponse
```

to `DaemonAPI`.

## Action plumbing

Thread a new `updateFromBase` closure through:

- `ActionHandler`
- `PodActions`
- any mock/default action initializer used by previews

After a successful request, trigger the same pod refresh/list refresh behaviour
that nearby actions use. For conflict responses, do not treat the HTTP request
as failed; show the conflict as an action result.

## ValidationTab UI

Add local state:

- `isUpdatingFromBase`
- optional last-result / conflict message if existing toast plumbing cannot
  show the result directly

Button visibility:

- show for `.validating`, `.failed`, `.reviewRequired`
- hide for all other statuses
- disable when already updating
- disable when there is no worktree or the pod is known to have a compromised
  worktree

Button placement:

- In the existing header action stack, between `Skip Validation` and
  `Interrupt` for validating pods.
- In failed/review_required, before `Force Approve`.

Suggested label:

```swift
Label("Update From Base", systemImage: "arrow.triangle.2.circlepath")
```

Result messaging:

- `queued_after_abort` - "Validation is stopping. Update from base will run next."
- `already_up_to_date` - "Already contains latest <baseBranch>."
- `rebased` - "Rebased onto <baseBranch>. Validation restarted."
- `conflict` - "Rebase conflict while updating from <baseBranch>:" plus the
  conflicted files.

Use existing toast/banner/error surfaces in `ActionHandler` if present. Avoid a
new modal in v1.

## Touches

- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` - response DTO and
  request method.
- `packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift` - action
  wrapper, result messaging, refresh.
- `packages/desktop/Sources/AutopodUI/Models/PodActions.swift` - action closure.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift` - button
  and state.
- `packages/desktop/Sources/AutopodUI/Models/Pod.swift` - only if a worktree /
  compromised-worktree flag needs to be exposed to the view model.
- `packages/desktop/Sources/AutopodUI/Preview Support/MockData.swift` - preview
  data/actions if needed.

## Does not touch

- No daemon or shared changes in this brief.
- No Pod card / Summary tab / global detail action rail button.
- No new conflict-resolution UI.

## Constraints

- Keep the button on the Validation tab only.
- Use the existing action visual style from nearby header buttons.
- Do not rearrange the rest of the Validation tab.
- Do not block the UI waiting for final validation pass/fail. The daemon request
  only reports the update-from-base decision; normal pod status updates carry
  validation results later.

## Test Expectations

Native SwiftUI does not have a firing `api` or `web` AC in the Autopod
validation engine, so this brief intentionally has no acceptance criteria.

The implementer should still run the available desktop build/test/previews used
in this repo and include results in the handover. Manual smoke should verify:

- button appears for validating/failed/review_required only.
- button is disabled while the request is in flight.
- `queued_after_abort`, `already_up_to_date`, `rebased`, and `conflict` produce
  readable user feedback.
- existing Open App / Skip Validation / Interrupt / Force Approve buttons still
  fit in the header.

## Wrap-up

- Include screenshots or a concise manual-smoke note in the handover.
- Mention whether `Pod.swift` needed a new worktree/compromised-worktree field
  or could reuse an existing one.
