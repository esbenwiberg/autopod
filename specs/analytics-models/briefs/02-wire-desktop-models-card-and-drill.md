---
title: "Wire desktop Models card and ModelsDrillView (leaderboard + comparison + failure-stage matrix)"
depends_on: [01-add-models-analytics-endpoint]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodClient/Types/ModelsAnalyticsResponse.swift
  - packages/desktop/Tests/AutopodClientTests/ModelsAnalyticsResponseTests.swift
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsDrillView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/cli/
  - packages/escalation-mcp/
  - packages/validator/
---

## Task

Surface the Models card on the analytics dashboard and the
three-section drill in the right pane (leaderboard + comparison
panel + failure-stage matrix). The fourth drill section — the
what-if simulator — ships in Brief 03 and edits the same
`ModelsDrillView.swift` file. Leave a clear extension point.

All data is consumed verbatim from the endpoint Brief 01 ships.

**Sequencing note:** the parallel spec `analytics-escalations`
Brief 02 also extends `AnalyticsCardKind` with `.escalations` and
edits the same exhaustive-switch sites
(`AnalyticsRightPaneView`, `AnalyticsView`, `MainView`). Merge
analytics-escalations Brief 02 BEFORE starting this brief. If
the escalations brief is in flight, rebase before opening the PR
for this one. Do not silently add `default:` arms to mask an
incoming `.escalations` case.

1. **Codable mirror** —
   `ModelsAnalyticsResponse.swift` decodes the exact shape from
   `design.md` → Contracts. Mirrors
   `ReliabilityAnalyticsResponse.swift` /
   `SafetyAnalyticsResponse.swift` /
   `ThroughputAnalyticsResponse.swift` patterns. Handle JSON
   nulls carefully — many fields are `T?` rather than `T`
   (`totalCostUsd`, `dollarPerPr`, `completeCostUsd`,
   `avgQuality`, `meanTtmSeconds`, all summary `*Model` /
   `*PerPr` / `bestQuality` / `mostUsedPodCount`,
   `cheapestDollarPerPrModel`).

2. **Daemon API client** — `DaemonAPI.swift` gains
   `getModelsAnalytics(days:)` next to the other analytics
   fetchers.

3. **Card kind enum** — `AnalyticsCardKind.swift` extends with
   `.models`. Existing exhaustive switches will fail to compile
   until they handle the new case — fix every call site in this
   brief.

4. **Section flip** — `AnalyticsSection.swift` already has a
   `.models` case stubbed with `isShipped: false` and
   `preselectedCard: nil`. Flip `isShipped` to `true` and set
   `preselectedCard` to `.models` (matching the prior phases'
   sidebar wiring). The sidebar sub-row becomes navigable.

5. **Right-pane routing** — `AnalyticsRightPaneView.swift` adds
   a `.models` switch case routing to `ModelsDrillView`. Thread
   a `loadModels` closure through the view's constructor.

6. **Card data wiring** — in `AnalyticsView.swift`, wire the
   Models card into the existing card-grid:
   - `value`: `summary.cheapestDollarPerPrModel ?? "—"`.
   - `sparkline`: `summary.mostUsedDailySparkline.map { Double($0.count) }`.
     Empty cohort → `nil`.
   - `delta`: built from `summary.cheapestDollarPerPrDelta`;
     format `String(format: "%+$.2f/PR", value)`; direction
     maps to the existing up/down/flat enum. Empty current OR
     prior eligible cohort → `nil`. Note: 'down' on this
     metric is **good** (cheaper) — DO NOT recolour the
     standard up/down chrome; the operator reads the metric
     semantically (same convention as escalations'
     self-recovery-rate 'up' = good).
   - **sub-line under value:** two-line stack —
     - Line 1: `"$\(formatTwoDecimals(cheapestDollarPerPr))/PR · best: \(bestQualityModel ?? "—")"`.
       When `cheapestDollarPerPr === nil`, omit the dollar
       portion. When `bestQualityModel === nil`, omit "best:".
       Don't render an empty fragment.
     - Line 2: `"most used: \(mostUsedModel ?? "—") (\(mostUsedPodCount ?? 0) pods)"`.
     - Both lines suppressed entirely when
       `summary.cohortSize == 0`. The value `—` carries the
       whole story for an empty cohort.

7. **Drill view** — new
   `ModelsDrillView.swift` with three sections in scroll order
   (leaderboard, comparison, failure-stage matrix) plus a sticky
   days picker (default 30; values 7/14/30/60/90) and a sticky
   model-vs-runtime grain toggle (default Model).
   Re-fetches on picker change. Per-section loading skeletons;
   per-section empty states; error banner above sections on
   fetch failure (mirroring `ReliabilityDrillView` /
   `ThroughputDrillView`).

   **Brief 03 extension point:** below the failure-stage matrix
   section, leave a `// MARK: What-if simulator (Brief 03)`
   comment so Brief 03 has a clear insertion point. Do not stub
   the simulator section in this brief — it would be unused
   code.

   - **Leaderboard table (Section 1)** — 7 columns: model · pods
     · success rate · $/PR · avg quality · mean TTM · escalation
     rate. Server-supplied ordering (do NOT re-sort client-side).
     Format per `design.md` → UX flows. When the grain toggle is
     `Runtime`, render `byRuntime[]` rows instead of `byModel[]`,
     using `runtime` as the row label. Rows with
     `podCount < 5` render the model name with a smaller-text
     caption "\(podCount) pods — low-signal" beneath. Cells
     with null values render `"—"`. Empty state:
     `"No terminal pods in last N days."`. Stats-only — no row
     click, no expansion.

   - **Side-by-side comparison panel (Section 2)** — 5 horizontal
     `Chart` groups, one per axis (success rate, $/PR, avg
     quality, mean TTM, escalation rate). Each group renders one
     `BarMark` per row in the source array (`byModel[]` or
     `byRuntime[]` per grain toggle). Skip null axis values
     entirely (don't render a zero-height bar that could be
     misread). Bar color keyed by row position in the sorted
     array — pick from a stable palette so the legend is
     consistent across the section. Legend below shows
     model/runtime name + color swatch. Empty state:
     `"No comparable models in last N days."`. Stats-only.

   - **Failure-stage matrix (Section 3)** — table with N+1
     columns (model + 8 stage columns: build, health, smoke,
     test, lint, sast, acValidation, taskReview). Cell content:
     `"\(podsFailed)/\(podsRan)"` with a colour ramp tied to
     `failureRate` (0 = neutral, 1 = red). Mirror
     `ReliabilityDrillView`'s `profileHeatmap` colour treatment
     if a shared helper is exposed; else inline a simple linear
     interpolation. Cells with `podsRan == 0` render `"—"` (no
     data; don't draw a "0/0 green" that implies "no
     failures"). Rows in `byModel[]` order; the `<unknown>` row
     renders normally when present. The matrix stays on model
     grain regardless of the section's grain toggle (the
     failure-stage matrix is not meaningful at the runtime grain
     — per `design.md`). Empty state:
     `"No validations ran on any model in last N days."`.

8. **MainView wiring** — `MainView.swift` passes
   `loadModels: { days in try await daemonAPI.getModelsAnalytics(days: days) }`
   into the existing `AnalyticsView(...)` call site (one-line
   addition, identical pattern to the prior phases'
   `loadReliability` / `loadQuality` / `loadSafety` /
   `loadThroughput` / `loadEscalations` closures).

## Touches

- `packages/desktop/Sources/AutopodClient/Types/ModelsAnalyticsResponse.swift` (new)
- `packages/desktop/Tests/AutopodClientTests/ModelsAnalyticsResponseTests.swift` (new)
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsDrillView.swift` (new)
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift`
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift`
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift`
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift`
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift`

## Does not touch

- `packages/daemon/` — endpoint and aggregator already shipped
  in Brief 01.
- `packages/shared/` — TS contract is the source of truth and is
  owned by Brief 01; do not duplicate.
- `packages/cli/`, `packages/escalation-mcp/`,
  `packages/validator/` — unrelated.

## Constraints

- Must consume the `AnalyticsCard` API verbatim (Phase 0 lock):
  `title`, `value`, `sparkline`, `delta`, `isSelected`, `onClick`.
  Do not widen.
- `AnalyticsCardKind` extends by exactly `.models`. Every
  exhaustive-switch site must be updated in this brief.
- `AnalyticsSection.models` flip from `isShipped: false` to
  `isShipped: true` AND set `preselectedCard: .models`. Do not
  add other section cases.
- Server-supplied ordering for `byModel` and `byRuntime` is
  authoritative; do not re-sort client-side.
- `byRuntime` is always exactly 3 entries in
  `claude / codex / copilot` order — render in the order
  provided; do not reshuffle. Zero-pod runtime rows still
  render (greyed if you like, but present so the toggle never
  shows fewer rows than expected).
- `mostUsedDailySparkline` length is always `days`; use it
  unmodified for the card sparkline.
- The failure-stage matrix stays on **model grain** regardless
  of the leaderboard / comparison grain toggle. Per
  `design.md` (model-keyed is the only useful grain for stage
  triage).
- 'down' direction on the cheapest-$/PR delta is GOOD (cheaper).
  Do NOT swap colour semantics. Operator interprets the metric
  semantically; the chrome stays consistent (same convention as
  escalations' rate-up = good).
- Brief 03 will append a what-if simulator section below the
  matrix. Leave a clear `// MARK: What-if simulator (Brief 03)`
  comment as an insertion point. Do not stub simulator UI in
  this brief.
- Sub-line two-line stack: line 1 + line 2 both render when
  non-empty; line 2 is suppressed only when `mostUsedModel ===
  null`. Don't collapse line 2 just because line 1's bestQuality
  is null.
- Drill structure mirrors `ReliabilityDrillView` /
  `QualityDrillView` / `SafetyDrillView` /
  `ThroughputDrillView` / `EscalationsDrillView` — sticky
  picker + grain toggle, per-section loading + empty states,
  error banner above sections.
- The leaderboard's "low-signal" caption fires when
  `podCount < 5` for `byModel[]` rows. Apply the same threshold
  for `byRuntime[]` rows when the grain toggle is `Runtime`
  (kept simple — the threshold is a magic number worth
  explaining inline with a comment referencing
  MIN_COHORT_FOR_HEADLINE in the daemon).
- `<unknown>` row in `byModel[]` renders normally in the
  leaderboard and matrix. In the comparison panel, skip its
  $/PR bar (null) but render its bars for the other axes.

## Test expectations

`ModelsAnalyticsResponseTests.swift` (modeled on
`ReliabilityAnalyticsResponseTests.swift` and
`ThroughputAnalyticsResponseTests.swift`):

- **Full happy-path JSON decode** — every key in the contract
  decodes into the expected Swift type. Includes a non-empty
  `byModel` (with one row carrying `dollarPerPr: null` to mirror
  an `<unknown>` bucket), a `byRuntime` of length 3 with one
  zero-pod runtime, a non-empty `failureStageMatrix` (with all
  8 stages including some `podsRan: 0` cells), and a non-empty
  `unknownModels`.

- **Minimal / empty payload decode** —
  `summary.cohortSize: 0`, all summary `*Model` fields null,
  empty `byModel`, `byRuntime` of length 3 all zero, empty
  `failureStageMatrix`, empty `unknownModels`, all-zero
  `mostUsedDailySparkline`.

- **Null-tolerant decode for cost fields** — fixture row with
  `totalCostUsd: null, dollarPerPr: null, completeCostUsd: null`
  decodes without throwing. The Swift properties are
  `Double?`.

- **Null-tolerant decode for quality / TTM fields** — fixture
  row with `avgQuality: null, meanTtmSeconds: null` decodes.

- **`<unknown>` row decode** — fixture with
  `model: "<unknown>"` decodes without special-casing (it's
  just a string).

- **Snake-case key handling** — confirm the JSONDecoder strategy
  matches the rest of `AutopodClient` (mirror what
  `ReliabilityAnalyticsResponseTests` does).

- **Direction enum decode** — `'up'` / `'down'` / `'flat'` all
  decode for `cheapestDollarPerPrDelta.direction`.

- **Stage label decode** — verify the 8 fixed stage labels
  (`build, health, smoke, test, lint, sast, acValidation,
  taskReview`) decode as Swift strings byte-for-byte.

- **Runtime enum decode** — fixture with
  `byRuntime: [{ runtime: "claude" ... }, { runtime: "codex" ... }, { runtime: "copilot" ... }]`
  decodes; verify length is 3.

The drill view itself is exercised via SwiftUI Previews (which
don't run in CI) and the diff reviewer; no XCTest coverage.
This matches the pattern of every prior analytics phase
(analytics-safety/06, analytics-reliability/02,
analytics-quality/03, analytics-throughput/02,
analytics-escalations/02 all ship `acceptance_criteria: []`).

## Risks / pitfalls

- **AnalyticsCardKind merge conflict** — analytics-escalations
  Brief 02 also touches this enum and the same exhaustive-switch
  sites. Merge escalations Brief 02 first; if not feasible,
  rebase before opening the PR for this brief and resolve the
  enum + switch cases by including BOTH new cases.
- **AnalyticsSection.models is pre-stubbed** — the case already
  exists with `isShipped: false`. Flip the flag; don't add a
  duplicate case.
- **Brief 03 file collision** — Brief 03 extends the same
  `ModelsDrillView.swift` file. Leave the marker comment so the
  insertion point is clear. Do NOT add a "TODO: simulator" stub
  in this brief — that would be dead code.
- **`<unknown>` row in leaderboard** — render normally. Don't
  hide it; the operator wants to see "1,200 pods on unrecognised
  models" so they know to update the pricing catalog.
- **Sparkline-of-most-used semantic** — the sparkline tracks the
  MOST-USED model's daily pod count, not the full cohort's.
  Document this in the card or the drill if it's not obvious;
  otherwise the operator might think a flat sparkline means "no
  pods" when it means "no pods on the most-used model
  specifically".
- **Direction colour semantics** — 'down' on cheapest-$/PR is
  good. Do not override the chrome to invert; the operator
  reads it semantically. Same convention as escalations'
  rate-up = good. If a reviewer pushes for inversion, defer to a
  separate UI polish ticket.
- **Empty-cohort value rendering** — `cohortSize == 0` → value
  is `"—"`, sub-line suppressed entirely, sparkline `nil`,
  delta `nil`. Do not render "0 pods" in the value position.
- **Per-row low-signal caption** — fires at `podCount < 5`.
  This is the same threshold the daemon uses to filter the
  headline determination. Hardcode 5 in this brief or expose it
  as a constant — fine either way; reference
  MIN_COHORT_FOR_HEADLINE in a comment so the magic number is
  traceable.
- **Switch exhaustiveness** — extending `AnalyticsCardKind` with
  `.models` will produce compile errors at every existing
  exhaustive switch (sidebar mapping, right-pane routing, card
  styling). Fix all of them in this brief; do not silently add
  `default:` arms to mask new cases.
- **Failure-stage colour ramp** — keep the brightest red below
  `failureRate == 1.0`; saturating at 1.0 makes a single
  failing pod look the same as a uniformly failing model. A
  linear interpolation between neutral and red across [0, 1]
  is acceptable; mirror reliability's treatment if it exposes a
  helper.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
