# Handover - firm-dinosaur

## Built

- Desktop now decodes `readinessReview` on pod responses and maps statuses, areas, findings,
  source refs, and approval metadata into typed UI models.
- `DaemonAPI.approvePod(...)` accepts an optional approval reason, and `ActionHandler.approve(...)`
  no longer optimistically marks pods approved before daemon acceptance.
- Detail view includes a header Readiness pill, compact Overview Readiness card, and dedicated
  Readiness tab.
- The Readiness tab renders pod readiness as an approval companion: compact green rows, expanded
  non-green rows, source refs limited to existing Validation, Work, Logs, Diff, Evidence, and PR
  surfaces, plus reason-gated approval for `risky` and `waived`.
- Single-PR series final pods compute a local Series Readiness rollup from loaded member pod
  snapshots and show it before pod-level readiness.
- Card-level approvals are disabled unless readiness is `ready`, so non-ready approvals must go
  through the detail Readiness tab.

## Deviations

- Touched `packages/desktop/Sources/AutopodUI/Views/Cards/PodCardFinal.swift` outside the brief's
  expected file list. This prevents card-level direct approval from bypassing the new Readiness
  routing rules.
- Updated `DaemonAPI.approveAllValidated()` to decode the daemon's additive
  `{ approved, skipped }` response from the previous brief. The menu action still ignores the
  payload, but this avoids decode failures against the new daemon contract.
- Did not modify `SeriesPipelineView.swift`; the Readiness tab computes and renders the series
  approval surface without needing the existing pipeline view.

## Contracts Downstream Pods Need

- `PodActions.approve` now has signature `(podId: String, reason: String?) async -> Void`.
- `DaemonAPI.approvePod(_:, squash:, reason:)` sends `{ squash?, reason? }` only when at least one
  field is present.
- `Pod.readinessReview` is optional. Nil should be treated as pending/unavailable, not as ready.
- `SeriesReadinessReview.rollup(for:seriesPods:)` is a UI projection only. It is not persisted and
  depends on the detail view having loaded member pods.
- `ReadinessSourceRef.detailTab` intentionally maps `quality` to Work and `event` to Logs. PR refs
  open `href` when present; there is no new PR drilldown tab.

## Files To Treat As Owned By This Brief

- `packages/desktop/Sources/AutopodUI/Models/ReadinessReview.swift`
- `packages/desktop/Sources/AutopodUI/Views/Detail/ReadinessTab.swift`
- Readiness-related additions in:
  - `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift`
  - `packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift`
  - `packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift`
  - `packages/desktop/Sources/AutopodClient/Types/PodResponse.swift`

## Landmines

- The Linux Autopod-self image has no `swift` executable, so focused Swift tests could not run in
  this pod. Run the Desktop package tests/build on a macOS/Xcode-capable machine before merging.
- The UI rollup infers the series approval surface from member pod snapshots already available in
  the detail view. If a future daemon returns a first-class series readiness object, prefer that
  over recomputing in the UI.
- Do not reintroduce optimistic approval status changes in `ActionHandler`; daemon readiness gates
  can reject missing reasons or non-ready automation paths.
