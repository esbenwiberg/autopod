# Handover: chronic-jay (analytics-models Brief 02)

## What was built

Surfaced the Models analytics card on the macOS dashboard and wired the full
three-section drill view (leaderboard + comparison panel + failure-stage matrix).

**New files:**
- `packages/desktop/Sources/AutopodClient/Types/ModelsAnalyticsResponse.swift` —
  Codable mirror of the TS contract from Brief 01. Reuses `ValidationStage` and
  `StageFailureRow` from `ReliabilityAnalyticsResponse.swift`. Defines
  `ModelsRuntimeKind` (own enum — `RuntimeType` from AutopodUI is not accessible
  from AutopodClient).
- `packages/desktop/Tests/AutopodClientTests/ModelsAnalyticsResponseTests.swift` —
  9 `@Test` functions covering full decode, empty payload, null cost/quality/TTM
  fields, `<unknown>` row, camelCase key strategy (no snake_case conversion),
  direction enum, stage labels, and runtime enum.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsDrillView.swift` —
  drill view with sticky header (days picker + grain toggle), three sections, and
  `// MARK: What-if simulator (Brief 03)` extension point at the bottom.

**Modified files:**
- `DaemonAPI.swift` — `getModelsAnalytics(days:)` added after escalations fetcher.
- `AnalyticsCardKind.swift` — `.models` case added; all exhaustive switches updated.
- `AnalyticsSection.swift` — `.models` flipped to `isShipped: true`,
  `preselectedCard: .models` set.
- `AnalyticsRightPaneView.swift` — `loadModels` closure threaded through;
  `.models` case routes to `ModelsDrillView`.
- `AnalyticsView.swift` — Models card wired into grid with value, sparkline,
  delta, and two-line subline.
- `MainView.swift` — `loadModelsAnalytics` closure passed through to
  `AnalyticsView` and `AnalyticsRightPaneView`.

**`AppRootView.swift` NOT modified** — consistent with the established pattern
(safety, throughput, escalations analytics closures are also absent there). The
daemon analytics closures are wired in `MainView.swift`, not `AppRootView.swift`.

## Interfaces / contracts changed

- `ModelsAnalyticsResponse` is the only new wire contract — Swift Codable mirror of
  the TS shape from Brief 01. `ModelsRuntimeKind` is a new Swift enum
  (`claude / codex / copilot`) co-located in `ModelsAnalyticsResponse.swift`; it
  does NOT use `RuntimeType` from AutopodUI.
- `AnalyticsCardKind` extended with `.models`. All exhaustive switches were updated
  in this brief; Brief 03 should not need to touch `AnalyticsCardKind`.
- `AnalyticsSection.models` is now `isShipped: true` with `preselectedCard: .models`.
- `AnalyticsView`, `AnalyticsRightPaneView`, and `MainView` all gained a new
  `loadModelsAnalytics` / `loadModels` closure parameter (optional, default nil).

## Files Brief 03 should edit

- `packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsDrillView.swift` —
  Brief 03 appends the what-if simulator section at the
  `// MARK: What-if simulator (Brief 03)` marker at the bottom of `body`'s
  `VStack`. The `response` property is `@State private` — Brief 03 will need the
  existing sections to pass `response` into the simulator, or restructure as needed.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsSimulator.swift` (new)
  — pure-Swift projection math per the brief.
- `packages/desktop/Tests/AutopodUITests/ModelsSimulatorTests.swift` (new) —
  XCTest for simulator math.

## Files Brief 03 should NOT modify (without good reason)

- `ModelsAnalyticsResponse.swift` — contract is locked; changing it breaks
  the running endpoint.
- `ModelsAnalyticsResponseTests.swift` — tests the wire contract, not the UI.
- `DaemonAPI.swift` — Brief 03 uses the same `getModelsAnalytics(days:)` already
  wired; no new endpoint needed.
- `AnalyticsCardKind.swift`, `AnalyticsSection.swift`, `AnalyticsRightPaneView.swift`,
  `AnalyticsView.swift`, `MainView.swift` — all wiring is complete; the simulator
  is inside the drill view, not a new card.

## Discovered constraints / landmines

- **JSONDecoder key strategy**: `AutopodClient` uses a plain `JSONDecoder()` with
  NO `keyDecodingStrategy` (camelCase JSON from the daemon). Do NOT set
  `.convertFromSnakeCase`. Confirmed by inspecting `DaemonAPI.swift` and the test
  fixtures.
- **`ModelsRuntimeKind` vs `RuntimeType`**: `RuntimeType` lives in
  `AutopodUI/Models/Profile.swift` and is not accessible from `AutopodClient`.
  `ModelsRuntimeKind` is the canonical type in `AutopodClient` for this contract.
- **`StageFailureRow` reuse**: Brief 01's `FailureStageCell` maps to Swift's
  `StageFailureRow` (from `ReliabilityAnalyticsResponse.swift`). The
  `ModelsFailureStageRow.stages` array is `[StageFailureRow]`. Brief 03 does not
  need to change this.
- **`completeCostUsd` field**: Present on `PerModelAggregate` as `Double?`. Brief 01
  handover noted this is needed by Brief 03's simulator weighted-average math.
  It decodes correctly from the wire contract.
- **`byRuntime[]` always 3 entries**: Zero-pod runtime rows are still emitted by
  the daemon. `ModelsDrillView` renders them (greyed if you like, but present).
- **MIN_COHORT_FOR_HEADLINE = 5**: Hardcoded in `ModelsDrillView.swift` as
  `private let minCohort = 5` with a comment referencing the daemon constant.
  Brief 03 should reuse this constant — don't introduce a duplicate.
