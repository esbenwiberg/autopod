# fond-sturgeon Handover

## Built

- Desktop now decodes `ValidationResponse.setup` and validation phase
  completion `setupResult` data.
- Added `ValidationPhase.setup` with display name `Setup`.
- `ValidationChecks` now tracks setup pass/fail/skip, setup failure output, and
  build tri-state status so skipped build does not render as passed.
- `ValidationProgress` now tracks setup state/output and marks downstream
  blocking phases skipped when setup fails before they start.
- ValidationTab renders Setup first, includes Setup in blocking phase counts and
  the summary state, and shows a setup detail panel with setup output plus a
  downstream-skipped note on failure.
- Feature overview and sales-pitch validation copy now describe the nine-gate
  pipeline beginning with setup.
- Added focused Desktop decode/map/progress tests for setup and historical
  validation payloads without setup data.

## Deviations

- The brief asked to run `/simplify`; no native slash-command tool is exposed in
  this container, so the pass was run via MCP `ask_ai` plus local diff review.
  Its findings were addressed by moving setup failure output formatting onto
  `SetupResultResponse` and moving downstream skipped state into
  `ValidationProgress`.
- The brief asked for local macOS Swift/Xcode validation when available. This
  Linux pod has neither `swift` nor `xcodebuild`, so Desktop Swift tests remain a
  human review item.
- The brief says commit and push, but the pod operating environment says not to
  run `git push`; changes are committed locally and the host system is expected
  to push.

## Changed Interfaces

- `SetupResultResponse.failureOutput: String?` formats setup failure output and
  optional error for Desktop consumers.
- `ValidationResponse.setup: SetupResultResponse?`
- `RawSystemEvent.setupResult: SetupResultResponse?`
- `ValidationPhase.setup`
- `ValidationPhaseResult.setupResult: SetupResultResponse?`
- `ValidationChecks.setup: Bool?`
- `ValidationChecks.build: Bool?`
- `ValidationChecks.setupOutput: String?`
- `ValidationChecks.validationPhaseCount == 9`
- `ValidationProgress.setup: ValidationPhaseState`
- `ValidationProgress.setupOutput: String?`

## Owned Files

The next pod should not modify these without a specific reason:

- `packages/desktop/Sources/AutopodClient/Types/EventTypes.swift`
- `packages/desktop/Sources/AutopodClient/Types/ValidationResponse.swift`
- `packages/desktop/Sources/AutopodUI/Models/Pod.swift`
- `packages/desktop/Sources/AutopodDesktop/Mapping/PodMapper.swift`
- `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift`
- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift`
- `packages/desktop/Sources/AutopodUI/Views/Features/FeatureOverviewView.swift`
- `packages/desktop/Sources/AutopodUI/Views/Features/SalesPitchView.swift`
- `packages/desktop/Tests/AutopodClientTests/DaemonAPITests.swift`
- `packages/desktop/Tests/AutopodClientTests/PodMapperTests.swift`
- `packages/desktop/Tests/AutopodUITests/ValidationProgressTests.swift`

## Constraints And Landmines

- Historical validation attempts omit `setup`; Desktop must continue treating
  missing setup as neutral/skipped and must not invent setup output.
- Setup is a blocking phase, not advisory. It is counted in the phase total;
  advisory QA remains outside `validationPhaseCount`.
- Setup failure can leave downstream daemon fields as skipped or not emitted.
  Live Desktop progress normalizes not-started downstream blocking phases to
  skipped when setup fails.
- `BuildResultResponse.status == "skip"` now maps to skipped build; do not
  reintroduce the previous `smoke || buildOutput == nil` build-status shortcut.
- Linux Autopod-self pods cannot run Desktop Swift/Xcode tests. A macOS reviewer
  should run the package/Xcode Desktop test suite and manually verify the
  validation tab UI scenarios.
