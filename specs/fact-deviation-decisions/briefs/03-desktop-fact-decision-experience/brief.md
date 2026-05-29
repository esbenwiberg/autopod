---
title: "Wire desktop fact-decision experience"
touches:
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift
  - packages/desktop/Sources/AutopodUI/Models/PodActions.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/SummaryTab.swift
  - packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift
  - packages/desktop/Sources/AutopodDesktop/Services/NotificationService.swift
does_not_touch:
  - packages/cli/
  - packages/daemon/
  - packages/shared/
  - packages/desktop/Sources/AutopodUI/Views/Profiles/
---

## Task

Update the macOS desktop app to consume the new batch fact-decision API and
present the approved user flow:

- Overview shows a specific "Required fact decision needed" state when
  validation is waiting on facts.
- Validation tab shows one batch decision panel for all pending required facts.
- No decision is preselected.
- `Apply Decisions & Revalidate` is disabled until every pending fact has an
  explicit choice.
- Use domain terms only: `Waive Required Fact`, `Use Replacement Proof`, and
  `Enforce Original Fact`.
- `Use Replacement Proof` appears only when the agent provided replacement
  proof.
- Summary/detail surfaces map internal decisions to domain labels, not raw
  `approved_*` or generic approve/reject wording.
- Native notification says `Required fact decision needed` for
  `validationCompleted` events whose `factValidation.status == "pending_human"`
  and does not also send the generic validation-failed notification.

## Touches

- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` - replace
  `approveFactWaiver(...)` with a batch fact-decision request type and method.
- `packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift` - replace
  action handler glue.
- `packages/desktop/Sources/AutopodUI/Models/PodActions.swift` - replace the
  closure exposed to views.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift` -
  replace per-fact approve waiver popovers with the batch panel.
- `packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift` -
  special-case review-required pods with pending facts.
- `packages/desktop/Sources/AutopodUI/Views/Detail/SummaryTab.swift` - render
  fact deviation decisions with domain terms.
- `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift` - branch
  validation-completed notification handling for pending facts.
- `packages/desktop/Sources/AutopodDesktop/Services/NotificationService.swift` -
  add a specific fact-decision notification method.

## Does Not Touch

Do not add CLI support. Do not keep the old approve-waiver client method. Do not
introduce new daemon or shared contracts in this brief.

## Constraints

- Use the existing validation tab visual language; this is a tool surface, not a
  marketing/hero redesign.
- Keep the batch panel stable in size as choices are made.
- Do not show generic "Approve" or "Reject" copy for fact decisions.
- Do not allow partial submission.
- Show replacement-proof choice only when replacement proof exists.
- Disable submit while the batch request is in flight.
- On success, refresh the pod/session through the existing store action path.
- If the backend returns a validation error, keep user selections visible and
  show the error near the panel.
- For native notifications, send either the specific fact-decision-needed
  notification or the generic validation result notification, never both for one
  event.

## Approved Wireframe

```text
Overview
┌ Required fact decision needed ──────────────────────┐
│ 2 required facts need decisions before validation.   │
│ [Open Validation]                                    │
└──────────────────────────────────────────────────────┘

Validation > Required Facts
┌ Required Fact Decisions (2) ─────────────────────────┐
│ Choose one decision for each pending fact.            │
│                                                       │
│ fact-swift-only                         pending       │
│ swift not found, exit 127                            │
│ ( ) Waive Required Fact                              │
│ ( ) Enforce Original Fact                            │
│                                                       │
│ fact-browser-proof                      pending       │
│ Replacement proof available                          │
│ ( ) Use Replacement Proof                            │
│ ( ) Enforce Original Fact                            │
│                                                       │
│ [Apply Decisions & Revalidate] disabled until 2/2 set │
└───────────────────────────────────────────────────────┘
```

## Test Expectations

No Linux-pod executable facts are required for this native desktop brief. Follow
`docs/conventions/convention-001-autopod-self-required-facts.md`: desktop
SwiftUI/AppKit verification belongs in human review or optional local Mac
verification until Autopod has a Mac runner.

Human review should verify:

- Overview state appears when a pod is `review_required` or `failed` with
  pending-human required facts.
- Validation tab batch panel renders all pending facts, no preselected
  decisions, correct domain terms, disabled submit until complete, in-flight
  disabled state, and visible backend error state.
- `Use Replacement Proof` appears only for facts with replacement proof.
- Summary tab maps decisions to domain terms.
- Pending-human fact validation sends the specific notification and not the
  generic validation-failed notification.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Run any available local desktop tests on a macOS/Xcode-capable machine if
   accessible.
3. Commit and push.
