---
title: "Add what-if simulator section to ModelsDrillView (client-side)"
depends_on: [02-wire-desktop-models-card-and-drill]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsDrillView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsSimulator.swift
  - packages/desktop/Tests/AutopodUITests/ModelsSimulatorTests.swift
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/cli/
  - packages/escalation-mcp/
  - packages/validator/
  - packages/desktop/Sources/AutopodClient/
  - packages/desktop/Sources/AutopodUI/Models/
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
---

## Task

Append a fourth section — **What-if simulator** — to the
`ModelsDrillView` that Brief 02 introduced. The simulator runs
**entirely on the client**, projecting fleet aggregates off the
`byModel[]` data Brief 01's endpoint already returns. No new
endpoint; no daemon change; no new shared types.

The simulator's design rationale and the "naïve projection"
trade is documented in `docs/decisions/ADR-023-simulator-client-side-naive-projection.md`.
Read it before implementing — the math assumptions matter for
the UI caveat copy.

1. **Projection module** — new
   `ModelsSimulator.swift` colocated with `ModelsDrillView`,
   exposing a pure-Swift function:
   ```swift
   public struct SimulatedFleet {
     public let dollarPerPr: Double?
     public let avgQuality: Double?
     public let successRate: Double
     public let meanTtmSeconds: Double?
     public let escalationRate: Double
   }

   /// Project fleet aggregates if `redirectFraction` of `source`'s
   /// terminal-cohort pods had run on `target` instead.
   /// Naïve assumption: redirected pods inherit `target`'s
   /// historical per-pod averages weighted by the redirected
   /// `podCount`.
   ///
   /// - byModel: every entry from Brief 01's response, including
   ///   the `<unknown>` row if present.
   /// - source / target: rows from byModel. source.model and
   ///   target.model must differ. Pass canonical model strings.
   /// - redirectFraction: 0..1 inclusive.
   public func projectFleet(
       byModel: [PerModelAggregate],
       source: PerModelAggregate,
       target: PerModelAggregate,
       redirectFraction: Double,
   ) -> SimulatedFleet
   ```
   See "Projection math" below for the exact formulas.

2. **Section UI** — extend `ModelsDrillView.swift` at the
   `// MARK: What-if simulator (Brief 03)` insertion point with
   a new `WhatIfSimulatorSection` view containing:

   - **Eligibility check.** Compute the eligible-model set:
     `byModel[]` rows where `model != "<unknown>" && podCount > 0`.
     If `eligible.count < 2`, render the empty state
     `"Need ≥2 models with priced cohort pods to simulate."`
     and skip the controls. The simulator IS the section — no
     point rendering disabled dropdowns.

   - **Caveat banner.** Persistent caption-style banner above
     the controls:
     `"Naïve projection — assumes target model performs identically to its past terminal-cohort pods. Validate before committing."`
     Restrained warning treatment (`!` glyph, muted background).
     Per ADR-023.

   - **Controls (vertical stack):**
     - Source dropdown — populated from `eligible`, sorted by
       `podCount DESC`. Default: first entry (most-used
       eligible).
     - Target dropdown — same population, sorted by `dollarPerPr
       ASC` (cheapest first; null `dollarPerPr` should not
       appear because eligible filters `<unknown>`). Default:
       first entry, BUT auto-advance to the next eligible if it
       equals the current source.
     - Source-Target invariant: source must not equal target.
       When the source picker changes to match the target,
       auto-advance the target to the next eligible model
       (most-used-among-eligible after the new source).
     - Redirect slider — `0...100` integer percentage,
       default `0`. Step `1`. Live-update on every tick.

   - **Projection table (5 rows × 4 columns):** `Axis | Current
     | Projected | Delta`. Rows: $/PR, Avg quality, Success
     rate, Mean TTM, Escalation rate. Values formatted as in the
     leaderboard (`$X.XX/PR`, integer quality, `N%`,
     `Xh Ym`, `N%`). `Current` is the fleet-wide aggregate
     across `eligible` (NOT all `byModel[]` — `<unknown>` is
     excluded because we can't price it). `Projected` is the
     result of `projectFleet(byModel: eligible, source:, target:, redirectFraction:)`.
     `Delta` is signed (`+0.03/PR`, `+2pp`, `-12m`); colour the
     sign neutrally — don't paint deltas red/green here because
     "good" depends on the axis (cheaper $/PR is good, higher
     quality is good, lower escalation rate is good). The
     operator reads the sign semantically.

   - **Default state.** Slider at 0% → `Projected` column
     equals `Current` exactly and `Delta` shows all zeros. The
     operator should be able to visually confirm "the math is
     consistent" by moving the slider from 0 and watching the
     deltas grow.

   - **No "Apply" / "Save" button.** The simulator is a
     read-only thought experiment. There is no persistence, no
     export, no link-out. Live projection is the entire feature.

## Projection math

Let `eligible = byModel.filter { $0.model != "<unknown>" && $0.podCount > 0 }`.

For an axis `A` (e.g. cost-per-PR), the **current fleet
aggregate** is the cohort-weighted average over `eligible`:

```
currentA = Σ (row.podCount × row.A) / Σ row.podCount
        = weighted average of row.A by podCount
```

where `row.A` is the row's per-model aggregate value for axis
A, treating nulls as "no contribution" (skip the row from BOTH
numerator and denominator for that axis only). For $/PR, the
weight is `completeCount`, not `podCount` (we're averaging
dollars per PR, not dollars per pod; per-pod weighting
underestimates models with high kill rates).

**Projection.** Define `redirected = floor(source.podCount ×
redirectFraction)` (truncate to integer pod count — the slider
is on whole pods, not fractions). Build a virtual `byModel`
where:

- `source'` has `podCount = source.podCount - redirected`.
  Other per-row stats (`successRate`, `avgQuality`,
  `meanTtmSeconds`, `escalationRate`, `dollarPerPr`) stay at
  source's historical per-pod averages — we're scaling volume,
  not redefining behavior.
- `target'` has `podCount = target.podCount + redirected`.
  Same per-pod averages as target's historical aggregates.
- All other rows pass through unchanged.

Then re-run the weighted average with `eligible'` = `eligible`
with `source` replaced by `source'` and `target` by `target'`.

**Per-axis nuances:**

- **$/PR.** Weight by `completeCount` (NOT `podCount`). When
  redirecting, also redirect the proportional fraction of
  `completeCount`: `redirectedComplete = floor(source.completeCount × redirectFraction)`.
  `source'.completeCount = source.completeCount - redirectedComplete`,
  `target'.completeCount = target.completeCount + redirectedComplete`.
  Fleet-wide `currentDollarPerPr = Σ row.totalCostUsd / Σ row.completeCount`
  where rows with null `totalCostUsd` or zero `completeCount`
  are skipped. Projected: same formula with virtual
  `totalCostUsd` for source' and target':
  `source'.totalCostUsd = source.dollarPerPr × source'.completeCount`,
  `target'.totalCostUsd = target.dollarPerPr × target'.completeCount`.
  When either source or target has null `dollarPerPr` (shouldn't
  happen for eligible models), bail out and return `nil` for the
  projected $/PR.

- **Avg quality.** Weight by `scoredCount`. Redirected
  `scoredCount` scales proportionally:
  `redirectedScored = floor(source.scoredCount × redirectFraction)`.
  If `target.avgQuality` is null (no quality rows on target),
  the projected target slice contributes nothing, but the
  removed source slice still removes its contribution — the
  result is the fleet average **excluding the redirected
  source pods entirely on this axis**. Document this in a
  comment; it's the honest behavior when target has no quality
  signal.

- **Success rate.** Weight by `podCount`. Redirected pods
  inherit target's `successRate` directly:
  `source'.completeCount = source'.podCount × source.successRate`,
  `target'.completeCount = target'.podCount × target.successRate`.
  (We're recomputing the fleet success rate, not faking pod
  counts.) Or equivalently, fleet `successRate = Σ row.podCount × row.successRate / Σ row.podCount`.

- **Mean TTM.** Weight by `completeCount` (TTM is only defined
  for complete pods). Same approach as $/PR. When target's
  `meanTtmSeconds` is null, the redirected slice contributes no
  TTM — projected TTM is the weighted average over the
  remaining rows.

- **Escalation rate.** Weight by `podCount`. Same as success
  rate but using `escalationRate`.

**Edge cases:**
- `redirectFraction == 0` → projected equals current on every
  axis. Verify in a unit test.
- `redirectFraction == 1` → all of source's pods move to
  target. Verify in a unit test.
- `source.podCount == 0` after the eligible filter — shouldn't
  happen (eligible requires podCount > 0), but defensively, the
  projection equals current.
- `target.dollarPerPr == nil` — shouldn't happen for eligible
  (filtered out `<unknown>`); defensively, projected $/PR
  returns `nil` and the table row shows `"—"`.

## Touches

- `packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsDrillView.swift`
  — append the simulator section at the Brief 02 insertion
  point.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsSimulator.swift`
  (new) — pure-Swift `projectFleet` + supporting types.
- `packages/desktop/Tests/AutopodUITests/ModelsSimulatorTests.swift`
  (new) — XCTest coverage of the projection math.

## Does not touch

- `packages/daemon/` — no endpoint, no aggregator change.
- `packages/shared/` — no contract change; consumes Brief 01's
  types verbatim.
- `packages/cli/`, `packages/escalation-mcp/`,
  `packages/validator/` — unrelated.
- `packages/desktop/Sources/AutopodClient/` — no new types, no
  new API method.
- `packages/desktop/Sources/AutopodUI/Models/` — no enum
  changes; the simulator is a section inside `ModelsDrillView`,
  not a new card kind.
- `AnalyticsView.swift`, `AnalyticsRightPaneView.swift`,
  `MainView.swift` — the simulator section is entirely
  internal to `ModelsDrillView`. Don't widen the surrounding
  routing.

## Constraints

- Pure-Swift math in `ModelsSimulator.swift`. No async, no I/O,
  no UI dependencies. The function takes plain Codable structs
  and returns a `SimulatedFleet`. Cheap to call on every slider
  tick.
- Eligible-model filter: `model != "<unknown>" && podCount > 0`.
  Document why `<unknown>` is excluded (can't price it).
- `<unknown>` pods are also excluded from the fleet-wide
  `Current` baseline (consistent with the simulator's
  projection — you can't simulate redirecting from a model you
  can't price).
- Caveat banner copy is **verbatim** from `design.md` (and
  ADR-023). Reviewers may push to soften it; defer to
  ADR-023's "we accept the false-assumption trade with an
  explicit user warning" framing.
- No persistence. The simulator state (source / target /
  fraction) is `@State` inside the section view. Days picker
  changes refetch the data; the simulator state is reset to the
  defaults (most-used source, cheapest target, 0% slider) on
  refetch.
- Slider step = 1%. Live-update on every tick (no debounce —
  the math is pure-Swift and trivially fast). If profiling
  shows a 60Hz update is too aggressive on a large `byModel[]`
  array, debounce to 30Hz; otherwise leave it raw.
- Delta colouring is **neutral** in this brief. Operators want
  to read signs semantically; don't paint deltas red/green
  here because the goodness of a sign varies per axis.
- The simulator does not call `loadModels` or any API — it
  operates only on the response already in memory from Brief
  02's drill.

## Test expectations

`ModelsSimulatorTests.swift`:

- **Zero-redirect identity** — fixture: 2 models (Opus, Haiku),
  any podCounts. Assert `projectFleet(..., redirectFraction: 0)`
  equals the current fleet aggregate on every axis (exact
  Double equality is fine for 0% since no math runs).

- **Full redirect math** — fixture: Opus
  `podCount: 10, completeCount: 10, totalCostUsd: 50, dollarPerPr: 5.0`,
  Haiku `podCount: 10, completeCount: 10, totalCostUsd: 5,
  dollarPerPr: 0.5`. Current fleet $/PR is
  `(50 + 5) / (10 + 10) = 2.75`. Project with source=Opus,
  target=Haiku, fraction=1.0 → all 10 Opus pods move to Haiku.
  Source' completeCount=0, target' completeCount=20. Source'
  totalCostUsd=0, target' totalCostUsd=0.5 × 20=10. Projected
  $/PR = 10 / 20 = 0.5. Assert
  `result.dollarPerPr ≈ 0.5`.

- **Partial redirect math** — same fixture. Project with
  fraction=0.5 → 5 Opus pods move to Haiku. Source'
  completeCount=5, target' completeCount=15. Source'
  totalCostUsd = 5 × 5 = 25, target' totalCostUsd = 0.5 × 15 =
  7.5. Projected $/PR = (25 + 7.5) / (5 + 15) = 1.625. Assert
  `result.dollarPerPr ≈ 1.625`.

- **Success rate weighted by podCount** — fixture: Opus
  `podCount: 10, successRate: 0.9`, Haiku
  `podCount: 10, successRate: 0.5`. Current fleet successRate =
  (10×0.9 + 10×0.5) / 20 = 0.7. Redirect 50% Opus→Haiku.
  Source' podCount=5, target' podCount=15. Projected =
  (5×0.9 + 15×0.5) / 20 = (4.5 + 7.5) / 20 = 0.6. Assert
  `result.successRate ≈ 0.6`.

- **TTM null on target** — fixture: Opus
  `meanTtmSeconds: 600`, Haiku `meanTtmSeconds: nil` (no
  complete pods). Redirect 50% Opus→Haiku. Result: redirected
  slice contributes no TTM; projected TTM is the average over
  Opus' remaining 5 complete pods (= 600). Assert
  `result.meanTtmSeconds ≈ 600`.

- **Quality null on target** — fixture: Opus
  `scoredCount: 10, avgQuality: 80`, Haiku
  `scoredCount: 0, avgQuality: nil`. Redirect 100% Opus→Haiku.
  Projected quality: no rows contribute. Assert
  `result.avgQuality == nil`.

- **`<unknown>` excluded from baseline** — fixture:
  `byModel: [Opus 10 pods $5/PR, <unknown> 10 pods nil cost]`.
  Current fleet $/PR (baseline) should be 5.0 (Opus only,
  `<unknown>` excluded — eligible filter strips it). Assert
  `eligible` derived from `byModel` has length 1; assert
  baseline math excludes the unknown row.

- **Escalation rate weighted by podCount** — fixture: Opus
  `podCount: 10, escalationRate: 0.3`, Haiku
  `podCount: 10, escalationRate: 0.1`. Current = 0.2. Redirect
  50% Opus→Haiku. Projected = (5×0.3 + 15×0.1) / 20 = (1.5 +
  1.5) / 20 = 0.15. Assert `result.escalationRate ≈ 0.15`.

- **Three-model fleet** — fixture: Opus, Sonnet, Haiku each
  with distinct stats. Redirect 30% Opus→Sonnet. Assert
  Haiku's contribution to all 5 projected axes is unchanged
  (we're not redirecting from or to Haiku).

The simulator section UI is exercised via SwiftUI Previews and
the diff reviewer; no XCTest coverage of the View itself. The
math IS unit-tested above. This matches every prior analytics
phase's convention (`acceptance_criteria: []` for desktop briefs;
behaviour anchored via TestExpectations).

## Risks / pitfalls

- **Floor-vs-round on `redirected` pod count** — `floor` is the
  conservative choice (a 30% redirect of 7 pods becomes 2,
  not 3). Document this; reviewers may suggest `round` for
  symmetry. Either works as long as the unit tests pin the
  behavior.
- **`<unknown>` in the eligible filter** — the filter is
  `model != "<unknown>" && podCount > 0`. Both predicates
  matter — a hypothetical priced model with `podCount: 0`
  shouldn't appear in the dropdowns (no historical data to
  project from).
- **Null propagation on quality / TTM** — the math gracefully
  handles null target axes by treating the redirected slice as
  contributing nothing. Be explicit in comments — silent null
  drops are confusing to readers who don't know the spec.
- **Slider performance** — pure-Swift weighted-average over a
  few dozen models is microseconds. If the cohort somehow grows
  to hundreds of distinct models, profile and consider
  debouncing. The current expected case is < 10 distinct
  models.
- **State reset on days-picker change** — when the user changes
  the days picker, Brief 02 refetches the data. The simulator
  state should reset to defaults (most-used source, cheapest
  target, 0% slider) rather than persist stale source/target
  IDs that may no longer exist in the new cohort. Easiest
  implementation: drive `@State` from `id(model)` derived from
  the loaded data and reset when the source array changes.
- **Default-source-equals-default-target** — when only one
  eligible model exists, the section's empty state (`Need ≥2
  models`) prevents this. When the most-used model happens to
  also be the cheapest, the default target auto-advances to the
  second-most-used. Unit-test this corner.
- **Caveat banner copy churn** — the banner text is verbatim
  from ADR-023. If reviewers push to change it, route through
  the ADR (it's a long-lived semantic decision, not a copy
  tweak).
- **Delta colour temptation** — paint deltas neutrally. The
  goodness of a sign varies per axis. If a reviewer insists on
  colour, the right fix is per-axis (`$/PR` down=green,
  `quality` up=green, etc.); discuss before painting.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Verify the SwiftUI Preview renders the simulator section
   with the default fixture.
4. Commit and push.
