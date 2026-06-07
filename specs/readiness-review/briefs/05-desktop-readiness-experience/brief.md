---
title: "Add Desktop Readiness Review tab and approval flow"
touches:
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift
  - packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift
  - packages/desktop/Sources/AutopodUI/Models/
  - packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ReadinessTab.swift
  - packages/desktop/Sources/AutopodUI/Views/Series/SeriesPipelineView.swift
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/cli/
  - packages/daemon/src/worktrees/pr-body-builder.ts
---

## Task

Add the Desktop Readiness Review experience:

- header Readiness pill;
- compact no-scroll Overview card;
- dedicated Readiness tab;
- single-PR Series Readiness layout;
- approval routing and reason flow.

The UI should present Readiness as an approval companion, not as another raw log
viewer.

## Touches

- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` - decode readiness
  payloads and send optional approval reason.
- `packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift` - map
  readiness status, area rows, findings, source refs, approval metadata, and
  series rollup data if returned by the daemon.
- `packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift` - route
  approval through daemon acceptance and avoid optimistic `.approved` status when
  the daemon may reject for missing reason.
- `packages/desktop/Sources/AutopodUI/Models/` - add UI model types as needed.
- `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift` - add
  the Readiness tab, header pill, and approval button routing.
- `packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift` - add the
  compact Overview Readiness card.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ReadinessTab.swift` - new tab
  that renders pod readiness and series readiness.
- `packages/desktop/Sources/AutopodUI/Views/Series/SeriesPipelineView.swift` -
  link or coordinate with the existing Series view only if needed; the Readiness
  tab remains the approval surface.

## Does Not Touch

Do not add a marketing/landing surface. Do not add raw action/security/network
drilldown screens in v1. Do not make Overview scrollier to fit Readiness. Do not
require a reason for `needs_review`.

## Constraints

- Overview remains compact and effectively no-scroll; use a single-line or
  two-line card:

  ```text
  Readiness: needs_review - 2 findings before approval [Open Readiness]
  ```

- Header pill labels `Readiness: ...` for normal pods and
  `Series Readiness: ...` when the selected/final pod is approving a single-PR
  series.
- `ready` approval can proceed from the header.
- `needs_review` approval routes to the Readiness tab, shows findings, and
  allows approval without a reason.
- `risky` and `waived` approval routes to the Readiness tab and disables approval
  until a non-empty reason is entered.
- Green rows stay compact; non-green rows are expanded enough to explain the
  finding and link to an existing source surface.
- Source refs link only to existing tabs/surfaces: Validation, Work, Logs, Diff,
  PR, and Evidence.
- Text must fit in compact panels across expected desktop widths.

## Approved Pod Wireframe

```text
Header
[Readiness: risky]              [Review & Approve] [Reject]

Overview
Readiness: risky - 2 findings need a human decision        [Open Readiness]

Readiness
+----------------------------------------------------------+
| Readiness Review                                         |
| risky - Validation was waived; denied egress observed.   |
| Computed 14:32                                           |
|                                                          |
| Validation      waived        Human skipped failed facts  |
| Security        ready         No blocking findings        |
| Actions         ready         Audit chain valid           |
| Network         needs_review  3 denied egress events      |
| Scope           ready         No drift detected           |
| Quality         needs_review  Low self-check signal       |
| Advisory QA     not_available Still running / not run     |
| PR              ready         Merge gate clean            |
|                                                          |
| Approval reason required                                 |
| [ Explain why this is acceptable...                    ] |
| [Approve with reason] disabled until text is entered      |
+----------------------------------------------------------+
```

## Approved Series Wireframe

```text
Header
[Series Readiness: needs_review]        [Review & Approve] [Reject]

Overview
Series Readiness: needs_review - 3 findings across 2 pods   [Open Readiness]

Readiness
+----------------------------------------------------------+
| Series Readiness                                         |
| needs_review - 3 findings across 2 of 5 pods             |
| Single PR: feature/readiness-review                      |
|                                                          |
| Overall areas                                            |
| Validation      ready         latest final validation OK  |
| Security        needs_review  warning in 01-backend      |
| Actions         ready         audit chain valid           |
| Advisory QA     needs_review  concern in 05-desktop      |
| PR              ready         merge gate clean            |
|                                                          |
| Member pods                                              |
| 01-backend      needs_review  Security warning            |
| 02-daemon       ready         no findings                 |
| 05-desktop      needs_review  Advisory QA concern         |
|                                                          |
| [Approve after review]                                   |
+----------------------------------------------------------+
```

## Test and Review Expectations

- Desktop decoding/mapping should be reviewed on a macOS/Xcode-capable machine
  with local Swift tests where practical.
- UI model behavior should be reviewed for whether approval requires a reason
  for each status.
- These are human-review checks, not required facts, because Autopod-self pods
  cannot rely on Swift or native macOS UI tooling inside the Linux pod image.

## Wrap-up

Before finishing:

1. Capture human review notes for decoding/mapping, layout, and interaction.
2. Run focused Swift tests only when working on a macOS/Xcode-capable machine.
3. Run the relevant desktop build/test command available on the Mac.
4. Commit and push.
