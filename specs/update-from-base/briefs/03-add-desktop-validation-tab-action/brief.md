---
title: "Add desktop Validation-tab Update From Base action"
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

```text
Validation tab header

Attempt 2 of 3                                      [Open App]
                                                    [Skip Validation]
                                                    [Update From Base]
                                                    [Interrupt]

For failed / review_required:

Attempt 3 of 3                                      [Update From Base]
                                                    [Force Approve]
```

Add a Swift response type matching the daemon union. The implementation may be
an enum or a struct with `action`, `ok`, `baseBranch`, `validation`, and
`conflicts` fields, depending on existing `DaemonAPI.swift` style.

Thread a new `updateFromBase` action through `ActionHandler`, `PodActions`, and
preview/mock action initializers. After a successful request, trigger the same
pod refresh/list refresh behaviour that nearby actions use. Conflict responses
are typed action results, not transport failures.

Button visibility:

- show for `.validating`, `.failed`, and `.reviewRequired`
- hide for all other statuses
- disable while already updating
- disable when there is no worktree or the pod is known to have a compromised
  worktree

Place the button in the existing header action stack between `Skip Validation`
and `Interrupt` for validating pods, and before `Force Approve` for
failed/review_required pods.

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

- `packages/daemon/` - daemon route and response are owned by brief 01.
- `packages/shared/` - response contract is owned by brief 01.
- `packages/cli/` - CLI is owned by brief 02.
- `packages/escalation-mcp/` - no agent/MCP path for this action.

## Constraints

- Follow `design.md` -> UX flows -> Desktop Validation Tab exactly for placement
  and visibility.
- Keep the button on the Validation tab only.
- Use the existing action visual style from nearby header buttons.
- Do not rearrange the rest of the Validation tab.
- Do not block the UI waiting for final validation pass/fail. The daemon request
  only reports the update-from-base decision; normal pod status updates carry
  validation results later.

## Test expectations

Native SwiftUI does not yet have an automated UI fact harness in Autopod, so the
contract uses human review for the visual behaviour.

The implementer should still run the available desktop build/test/previews used
in this repo and include results in the handover. Manual smoke should verify:

- button appears for validating/failed/review_required only.
- button is disabled while the request is in flight.
- `queued_after_abort`, `already_up_to_date`, `rebased`, and `conflict` produce
  readable user feedback.
- existing Open App / Skip Validation / Interrupt / Force Approve buttons still
  fit in the header.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
