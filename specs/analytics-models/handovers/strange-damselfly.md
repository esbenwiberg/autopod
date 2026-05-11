# Handover: strange-damselfly (analytics-models Brief 03)

## What was built

Appended the **What-if simulator** as a fourth section to `ModelsDrillView`.

**New files:**
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsSimulator.swift` —
  pure-Swift projection math. Exports:
  - `unknownModelKey: String` — `"<unknown>"` constant for the unpriced-model bucket
  - `PerModelAggregate.isSimulatorEligible: Bool` — extension on the AutopodClient type;
    true when `model != unknownModelKey && podCount > 0`
  - `SimulatedFleet` — `Equatable` struct with all 5 projected axes (`dollarPerPr?`,
    `avgQuality?`, `successRate`, `meanTtmSeconds?`, `escalationRate`)
  - `projectFleet(byModel:source:target:redirectFraction:) -> SimulatedFleet` — public
    top-level function; `redirectFraction == 0` short-circuits to the exact baseline
    (avoiding float-recompute of `totalCostUsd` from `dollarPerPr`)
- `packages/desktop/Tests/AutopodUITests/ModelsSimulatorTests.swift` — 8 `@Test`
  functions covering zero-redirect identity, full redirect $/PR, partial redirect $/PR,
  success rate weighting, TTM null on target, quality null on target, `<unknown>`
  exclusion, escalation rate weighting, and three-model fleet.

**Modified files:**
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsDrillView.swift` —
  `WhatIfSimulatorSection` private struct appended; `simulatorSection` + `simulatorEligibleKey`
  computed properties added to `ModelsDrillView`; `.id(simulatorEligibleKey)` pattern
  resets `@State` when data refetches.
- `packages/desktop/Package.swift` — `AutopodUITests` test target added (depends on
  `AutopodUI` + `AutopodClient`; path `Tests/AutopodUITests`).
- `packages/desktop/Tests/AutopodClientTests/AnalyticsWiringTests.swift` — fixed two
  stale tests left over from Brief 02:
  - `unshippedSectionsAreThroughputAndModels` → renamed + now asserts only `.throughput`
    is unshipped (`.models` is shipped since Brief 02)
  - `sectionPreselectedCardMapping` → `.models.preselectedCard == .models` (not nil)

## Interfaces / contracts changed

- `ModelsSimulator.swift` is new public API in `AutopodUI`. Downstream pods that touch
  `ModelsDrillView.swift` or write code against `PerModelAggregate` in `AutopodUI` scope
  will see `isSimulatorEligible` and `unknownModelKey` in scope.
- No wire contract changes — Brief 03 consumes Brief 01's `ModelsAnalyticsResponse`
  verbatim; no new endpoint, no new shared types.
- `Package.swift` adds `AutopodUITests` target; existing `AutopodClientTests` is unchanged.

## Files the next pod should NOT modify (without good reason)

- `ModelsSimulator.swift` — math is locked by the 8 unit tests; changes must keep all
  passing.
- `ModelsSimulatorTests.swift` — tests are the contract for `projectFleet` math.
- `AnalyticsWiringTests.swift` — the two fixed assertions are now correct; don't revert.

## Discovered constraints / landmines

- **`unknownModelKey` and `isSimulatorEligible` scope**: both are defined in
  `ModelsSimulator.swift` at module scope (`internal`). They're accessible throughout
  `AutopodUI` (including `ModelsDrillView.swift`) without import. If another pod splits
  these files into different modules, the access will break.
- **`@State` reset via `.id(simulatorEligibleKey)`**: `WhatIfSimulatorSection` relies on
  `ModelsDrillView` passing an `.id()` that changes when the eligible model set changes.
  If someone removes the `.id()` from `simulatorSection`, the slider state will persist
  stale after a days-picker change.
- **Floor on `redirected` pod count**: `projectFleet` uses `Int(floor(...))` — conservative.
  Reviewers who suggest `round` instead must update the unit tests (the partial-redirect
  test fixture pins the floor behaviour with `floor(10 × 0.5) = 5`).
- **`projectionTableView` calls `projectFleet` twice** (once at 0% for current, once at
  the actual fraction for projected). This is intentional — at 0% the short-circuit is
  free, and the math is O(n) with n < 10. Do not "optimize" by caching; it complicates
  state flow without measurable benefit.
- **`AutopodUITests` is a new test target** — if Package.swift is regenerated from a
  template, this target may be dropped. It must exist for `ModelsSimulatorTests.swift`
  to be compiled.
- **Swift not available in the sandbox**: Swift tests can't be run in the CI container.
  Correctness is anchored in the unit test file + diff reviewer. TypeScript build/test
  passes (2538 tests).
