# Design — Analytics Models

## Blast radius

### Shared (Brief 01)
- `packages/shared/src/types/analytics.ts` (modify) — add
  `ModelsAnalyticsResponse`, `ModelsSummary`,
  `PerModelAggregate`, `PerRuntimeAggregate`,
  `FailureStageRow`, `UnknownModelSample`. Mirrors the location
  used by Cost/Quality/Safety/Throughput/Escalations.
- `packages/shared/src/index.ts` (modify) — re-export the new
  types.
- `packages/shared/src/pricing/index.ts` (modify) — add the
  `MODEL_CANONICAL` alias coalescing map and the
  `canonicalModelKey(model: string | null): string | null`
  helper. See ADR-022.

### Daemon (Brief 01)
- `packages/daemon/src/pods/models-aggregator.ts` (new) — pure
  aggregation function from raw query rows to
  `ModelsAnalyticsResponse`. Co-located with the other analytics
  aggregators (same data domain).
- `packages/daemon/src/pods/models-aggregator.test.ts` (new) —
  unit tests for cohort selection, per-model rollup math (with
  empty cohort, single-model case, mixed runtimes, missing
  quality rows), unknown-model handling, alias coalescing,
  failure-stage matrix derivation.
- `packages/daemon/src/api/routes/pods.ts` (modify) — register
  `GET /pods/analytics/models`. Mirror the Reliability /
  Throughput / Escalations route registration pattern at
  `pods.ts:244-256`; do not refactor adjacent routes.
- `packages/daemon/src/api/routes/pods.test.ts` (modify) —
  extend with route-level integration tests modelled on the
  Reliability block.
- `packages/daemon/src/index.ts` (modify) — wire the new
  aggregator into the route registration, alongside the existing
  reliability / quality / cost / safety / throughput /
  escalations wiring.

### Desktop (Brief 02)
- `packages/desktop/Sources/AutopodClient/Types/ModelsAnalyticsResponse.swift`
  (new) — Codable mirror of the TS contract.
- `packages/desktop/Tests/AutopodClientTests/ModelsAnalyticsResponseTests.swift`
  (new) — JSON-decode coverage modelled on
  `ReliabilityAnalyticsResponseTests.swift`.
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift`
  (modify) — add `getModelsAnalytics(days:)` next to the other
  analytics fetchers.
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift`
  (modify) — extend the enum with `.models`. Existing exhaustive
  switches will fail to compile until they handle the new case —
  do that in this brief.
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift`
  (modify) — flip the existing `.models` section to
  `isShipped: true` and set its `preselectedCard` to `.models`
  (matching prior phases' sidebar wiring).
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`
  (modify) — add `.models` switch case routing to the new drill
  view; thread a `loadModels` closure through the constructor.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift`
  (modify) — Models card data wiring (value = cheapest-$/PR
  model name, sparkline = most-used-model daily pod count,
  delta on summary.cheapestDollarPerPrDelta, sub-line per UX-flows
  section).
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsDrillView.swift`
  (new in Brief 02; extended in Brief 03) — leaderboard table,
  side-by-side comparison panel, failure-stage matrix. Brief 03
  appends the simulator section.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift`
  (modify) — pass `loadModelsAnalytics` closure into the
  existing `AnalyticsView(...)` call site.

### Desktop (Brief 03 only)
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsDrillView.swift`
  (modify) — append a `WhatIfSimulatorSection` view below the
  existing three sections.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ModelsSimulator.swift`
  (new) — pure-Swift projection math
  (`projectFleet(byModel: source: target: redirectFraction:)`)
  + co-located lightweight unit tests via
  `ModelsSimulatorTests.swift`.
- `packages/desktop/Tests/AutopodUITests/ModelsSimulatorTests.swift`
  (new) — XCTest covering the weighted-average math, the
  same-source-as-target identity case, the no-pods-on-source
  guard, the cost-with-unknowns guard, and zero/100% slider
  positions.

## Seams

Three briefs, two pod boundaries:

1. **Daemon endpoint (Brief 01)** — owns the aggregator, the
   route, the TS contract, and `MODEL_CANONICAL`. Foundation for
   Briefs 02 + 03.
2. **Desktop card + leaderboard + comparison + failure matrix
   (Brief 02)** — consumes the contract from Brief 01 verbatim.
   Hard sequential dependency on Brief 01.
3. **Desktop what-if simulator (Brief 03)** — consumes the SAME
   contract from Brief 01 verbatim (no extra endpoint). Appends
   a section to the drill view Brief 02 introduced. Hard
   sequential dependency on Brief 02 (it edits the view Brief 02
   creates).

Brief order:
- 01 ships first (sequential — owns shared types).
- 02 must follow 01 (contract dependency).
- 03 must follow 02 (view-file dependency).

### Coordination with analytics-escalations (Phase 5b)

If `analytics-escalations` Brief 02 is still in flight when
`analytics-models` Brief 02 starts, the two collide on
`AnalyticsCardKind.swift`, `AnalyticsRightPaneView.swift`,
`AnalyticsView.swift`, and `MainView.swift`. The two desktop
briefs are independent in scope but extend the same exhaustive
enum + switch sites. **Merge analytics-escalations Brief 02
before starting analytics-models Brief 02** (same convention as
escalations' coordination note against throughput). Brief 01 of
each spec is fully independent (different aggregator file,
different route, different shared-types section).

## Contracts

`ModelsAnalyticsResponse` is the only cross-pod contract on the
wire. Brief 01 owns the TS source; Brief 02 mirrors in Swift.
Brief 03 consumes the same Swift mirror.

```ts
// packages/shared/src/types/analytics.ts (added in Brief 01)

import type { RuntimeType } from './runtime';

export type ValidationStage =
  | 'build'
  | 'health'
  | 'smoke'
  | 'test'
  | 'lint'
  | 'sast'
  | 'acValidation'
  | 'taskReview';

/** Stage failure cell. Mirrors ReliabilityAnalyticsResponse's
 *  profileHeatmap stage entry shape verbatim — same semantics. */
export interface FailureStageCell {
  stage: ValidationStage;
  /** Distinct pods that ran this stage at least once over the
   *  trailing window. */
  podsRan: number;
  /** Distinct pods whose most-recent run of this stage failed. */
  podsFailed: number;
  /** = podsFailed / podsRan when podsRan > 0; else 0. In [0, 1]. */
  failureRate: number;
}

export interface FailureStageRow {
  /** Canonical model key (post-MODEL_CANONICAL coalescing). May
   *  also be the literal string '<unknown>' to bucket
   *  unpriced-model pods. */
  model: string;
  /** Always 8 entries in the fixed STAGES order:
   *  build, health, smoke, test, lint, sast, acValidation,
   *  taskReview. Empty cohort emits all zeros. */
  stages: FailureStageCell[];
}

export interface PerModelAggregate {
  /** Canonical model key (post-MODEL_CANONICAL coalescing). For
   *  the unknown bucket: literal '<unknown>'. */
  model: string;
  /** Total distinct terminal-cohort pods on this model. */
  podCount: number;
  /** Subset of podCount with status='complete'. */
  completeCount: number;
  /** Subset of podCount with status='killed'. */
  killedCount: number;
  /** Subset of podCount with status='failed'. */
  failedCount: number;
  /** = completeCount / podCount. In [0, 1]. Null when podCount === 0
   *  (can't happen in practice — a model only appears with at
   *  least one pod). */
  successRate: number;
  /** SUM(effectiveCostUsd) over terminal-cohort pods on this
   *  model, including killed/failed (waste counts). Null when
   *  model === '<unknown>' (we can't price it). */
  totalCostUsd: number | null;
  /** totalCostUsd / completeCount. Null when completeCount === 0
   *  (no PRs to amortise across) OR when model === '<unknown>'. */
  dollarPerPr: number | null;
  /** Subset of podCount with a pod_quality_scores row. */
  scoredCount: number;
  /** Mean of pod_quality_scores.score over scoredCount pods.
   *  Null when scoredCount === 0. In [0, 100] (validator scale). */
  avgQuality: number | null;
  /** Mean of (completed_at - created_at) seconds over
   *  completeCount pods. Null when completeCount === 0. */
  meanTtmSeconds: number | null;
  /** Distinct cohort pods on this model with ≥1 escalation of
   *  type IN ('ask_human','report_blocker','validation_override',
   *  'action_approval'). */
  escalatedCount: number;
  /** = escalatedCount / podCount. In [0, 1]. */
  escalationRate: number;
  /** Sum of effectiveCostUsd across cohort pods on this model
   *  with status='complete' only. Used as one component of the
   *  simulator's projected cost when the operator redirects from
   *  this model. Null when model === '<unknown>'. */
  completeCostUsd: number | null;
}

export interface PerRuntimeAggregate {
  /** RuntimeType — claude / codex / copilot. */
  runtime: RuntimeType;
  podCount: number;
  completeCount: number;
  killedCount: number;
  failedCount: number;
  successRate: number;
  /** SUM(effectiveCostUsd) including unknown-model pods (runtime
   *  is set regardless of model pricing). May still be 0 if all
   *  pods on this runtime had zero-cost models. */
  totalCostUsd: number;
  dollarPerPr: number | null;
  scoredCount: number;
  avgQuality: number | null;
  meanTtmSeconds: number | null;
  escalatedCount: number;
  escalationRate: number;
}

export interface UnknownModelSample {
  /** Verbatim pods.model string that didn't resolve. */
  rawModel: string;
  /** Distinct cohort pod count carrying this raw model string. */
  podCount: number;
}

export interface ModelsSummary {
  /** Canonical-model name of the row with the lowest dollarPerPr
   *  across byModel[] where completeCount >= MIN_COHORT_FOR_HEADLINE
   *  (5) AND model !== '<unknown>'. Null when no model is
   *  eligible. */
  cheapestDollarPerPrModel: string | null;
  /** dollarPerPr value for cheapestDollarPerPrModel. Null when
   *  cheapestDollarPerPrModel is null. */
  cheapestDollarPerPr: number | null;
  /** Canonical model name with the highest avgQuality across
   *  eligible rows (same eligibility predicate as cheapest$/PR
   *  plus scoredCount >= MIN_COHORT_FOR_HEADLINE). Null when no
   *  model qualifies. */
  bestQualityModel: string | null;
  /** Quality value (0..100) for bestQualityModel. Null when
   *  bestQualityModel is null. */
  bestQuality: number | null;
  /** Canonical model name with the highest podCount across ALL
   *  byModel rows (no MIN_COHORT_FOR_HEADLINE gate — most-used
   *  is a volume question, not a quality one). May be '<unknown>'
   *  if unpriced-model pods dominate the cohort; the desktop
   *  side decides whether to render it. Null when cohort is
   *  empty. */
  mostUsedModel: string | null;
  /** podCount for mostUsedModel. Null when mostUsedModel is null. */
  mostUsedPodCount: number | null;
  /** Total distinct terminal-cohort pods over the window. */
  cohortSize: number;
  /** One entry per day in window (length === days). count =
   *  number of terminal-cohort pods whose pods.model coalesces to
   *  mostUsedModel AND whose completed_at falls in that local-UTC
   *  day. Days with zero pods emit count = 0. Empty cohort emits
   *  all zeros. */
  mostUsedDailySparkline: Array<{ day: string; count: number }>;
  /** Signed difference in cheapestDollarPerPr vs the
   *  immediately-prior window of the same length. value is in
   *  absolute USD (e.g. -0.42 means $0.42 cheaper this window
   *  than last). 'down' on $/PR is GOOD (cheaper); the desktop
   *  may render the chrome semantically, but the JSON does not
   *  encode that. Direction: 'down' when value < -0.005, 'up'
   *  when > 0.005, 'flat' otherwise. Returns
   *  { value: 0, direction: 'flat' } when either window has
   *  cheapestDollarPerPr === null. */
  cheapestDollarPerPrDelta: {
    value: number;
    direction: 'up' | 'down' | 'flat';
  };
}

export interface ModelsAnalyticsResponse {
  summary: ModelsSummary;
  /** Sorted by podCount DESC, ties broken by model name ASC.
   *  The '<unknown>' row, when present, sorts naturally with
   *  the others (no special placement). */
  byModel: PerModelAggregate[];
  /** Exactly 3 entries (claude / codex / copilot), in that
   *  fixed order. Zero-pod runtimes still emit a row with
   *  podCount: 0 and null-valued averages. */
  byRuntime: PerRuntimeAggregate[];
  /** One row per canonical model that appears in byModel,
   *  including '<unknown>' if there are unpriced-model pods.
   *  Same sort order as byModel. */
  failureStageMatrix: FailureStageRow[];
  /** Up to 10 sample raw model strings that didn't resolve via
   *  MODEL_CANONICAL. Sorted by podCount DESC, then rawModel ASC.
   *  Length <= 10. Empty when every pod's model resolved. */
  unknownModels: UnknownModelSample[];
}
```

### Validation rules (mirror Reliability/Throughput/Quality/Safety/Escalations)
- `days` defaults to `30`.
- `days < 1` → `400 { error: 'days must be a positive integer', code: 'invalid_days' }`.
- `days > 365` → `400` with the same code.

### Cohort discipline (NON-NEGOTIABLE)

Two cohorts in one endpoint. Name them distinctly in the
aggregator and use them only where they belong:

| Section | Cohort | Notes |
|---------|--------|-------|
| `summary.cohortSize`, `summary.mostUsedDailySparkline`, `byModel[]`, `byRuntime[]`, `failureStageMatrix[]`, `unknownModels[]` | terminal cohort | reuse `buildTerminalCohortClause(days)` |
| `byModel[].escalatedCount` / `escalationRate` | terminal-cohort pods × `escalations` joined by `pod_id` with `type IN ('ask_human','report_blocker','validation_override','action_approval')` | same predicate as phase 5b |
| `failureStageMatrix[].stages[].podsRan` / `podsFailed` | terminal-cohort pods × `validations` joined by `pod_id` | mirror reliability-aggregator's STAGE accumulation |

All sections in this endpoint are cohort-pinned. Unlike
escalations (which had three cohorts), models has exactly one —
terminal cohort — applied uniformly.

Reuse `buildTerminalCohortClause(days)` from prior phases (check
`reliability-aggregator.ts`, `throughput-aggregator.ts`,
`escalations-aggregator.ts`, `safety-aggregator.ts`). If it's
still inlined per-aggregator, inline the predicate identically
here and add a `// keep in sync with: ...` comment.

### Alias coalescing

Every aggregator query reads `pods.model` raw. Coalescing happens
in JS, not SQL — apply `canonicalModelKey(rawModel)` (from
`packages/shared/src/pricing/index.ts`) on the way out of the
query and key the rollup maps by the canonical value. Three
buckets:

1. **Canonical hit** — `rawModel` is a key in `MODEL_PRICING`
   directly (e.g. `claude-opus-4-7`). Use as-is.
2. **Alias hit** — `rawModel` is in `MODEL_CANONICAL` (e.g.
   `opus` → `claude-opus-4-7`). Coalesce, then use.
3. **Unknown** — `rawModel` is neither. Bucket under
   `<unknown>` in `byModel[]` AND `failureStageMatrix[]`; record
   the raw string + pod count in `unknownModels[]` (capped at
   10 entries). The `<unknown>` bucket carries
   `totalCostUsd: null`, `dollarPerPr: null`,
   `completeCostUsd: null` — we can't price what we don't know.

ADR-022 documents the alias map and the unknown-bucket policy.

### Per-model rollup derivation

```sql
-- terminal cohort, see buildTerminalCohortClause
WITH cohort AS (
  SELECT id, profile_name, model, runtime, status, created_at,
         completed_at, input_tokens, output_tokens, cost_usd
  FROM pods
  WHERE output_mode != 'workspace'
    AND status IN ('complete', 'killed', 'failed')
    AND completed_at >= datetime('now', '-' || @days || ' days')
)

SELECT id, model, runtime, status, created_at, completed_at,
       input_tokens, output_tokens, cost_usd
FROM cohort
```

Iterate in JS:
- `canonical = canonicalModelKey(model) ?? '<unknown>'`.
- Bump `byModel[canonical].podCount`.
- Bump `byRuntime[runtime].podCount` (runtime is always set; no
  coalescing needed).
- For `status='complete'`: bump `completeCount`, accumulate
  `mttmSecondsSum`, `effectiveCostUsd(pod)`,
  `completeCostUsd` (canonical row).
- For `status='killed'` / `'failed'`: bump the matching counter.
- Accumulate `totalCostUsd` for all statuses (waste counts).

After the loop:
- `successRate = completeCount / podCount`.
- `dollarPerPr = (completeCount > 0 && model !== '<unknown>') ? totalCostUsd / completeCount : null`.
- `meanTtmSeconds = (completeCount > 0) ? mttmSecondsSum / completeCount : null`.

Quality requires a second query:

```sql
SELECT q.pod_id, q.score, p.model
FROM pod_quality_scores q
JOIN cohort p ON p.id = q.pod_id
```

Group by `canonicalModelKey(p.model)` and accumulate `scoreSum` +
`scoredCount`. `avgQuality = scoreSum / scoredCount` (null when
0). Mirror for `byRuntime`.

Escalations require a third query (mirror phase 5b's predicate):

```sql
SELECT DISTINCT e.pod_id, p.model, p.runtime
FROM escalations e
JOIN cohort p ON p.id = e.pod_id
WHERE e.type IN ('ask_human', 'report_blocker',
                 'validation_override', 'action_approval')
```

Group distinct `pod_id` by `canonicalModelKey(p.model)` for
`byModel.escalatedCount`; group by `p.runtime` for
`byRuntime.escalatedCount`. Then divide by the matching
`podCount`.

### Failure-stage matrix derivation

Mirror `reliability-aggregator.ts`'s `profileHeatmap` accumulation
verbatim, but key by canonical model instead of profile name:

```sql
SELECT v.pod_id, v.stage, v.passed, p.model
FROM validations v
JOIN cohort p ON p.id = v.pod_id
```

For each row:
- Skip if `v.stage` is not in the 8 known
  `ValidationStage` values.
- `canonical = canonicalModelKey(p.model) ?? '<unknown>'`.
- Add `v.pod_id` to `matrix[canonical][stage].ran`.
- If `!v.passed`: add to `matrix[canonical][stage].failed`.

A pod with multiple `validations` rows for the same stage counts
once per Set (most-recent failure wins via the
`failed.size / ran.size` ratio — same convention as reliability).

Emit one `FailureStageRow` per canonical model in `byModel`
(including `<unknown>` when present). Each row carries all 8
stages even if some have `podsRan === 0` (matches reliability's
emit-all-stages convention).

### Prior-window delta

Mirror the pattern at `reliability-aggregator.ts:248-263`. Run
the same aggregation against the immediately-prior window of
identical length to derive
`summary.cheapestDollarPerPrDelta.value`. Direction: `down` when
value < -0.005 (cheaper is good), `up` when > 0.005, else `flat`.
When either window's `cheapestDollarPerPr === null` (no eligible
model), emit `{ value: 0, direction: 'flat' }`.

## UX flows

### Sidebar
The locked Phase 0 contract — single `Analytics` row plus
sub-rows. The `.models` sub-row was previously stubbed with
`isShipped: false`; flip it to `true` in Brief 02 and set its
`preselectedCard` to `.models` (matching the prior phases'
pattern).

### Overview — Models card
Same `AnalyticsCard` API as the others
(`AnalyticsView.swift:84-96`):

- **value:** `summary.cheapestDollarPerPrModel ?? "—"`. The
  cheapest model NAME is the headline — the cents/dollar value
  is too noisy for the at-a-glance grid; the operator gets the
  value when they drill in. When null (no eligible model), show
  `"—"`.
- **sparkline:** `summary.mostUsedDailySparkline.map(\.count)`.
  Empty cohort → nil sparkline. The sparkline answers "is the
  most-used model staying steady, ramping, or fading?".
- **delta:** `AnalyticsCardDelta` formatted as
  `String(format: "%+$.2f/PR", summary.cheapestDollarPerPrDelta.value)`,
  direction mapped from
  `summary.cheapestDollarPerPrDelta.direction`. Empty current
  or prior window → nil. Note: 'down' on $/PR is **good**
  (cheaper); keep the standard chrome (the operator reads
  semantically — same convention as escalations'
  self-recovery-rate 'up' = good).
- **sub-line under value:** two-row stack —
  - Row 1: `"$\(formatCents(cheapestDollarPerPr))/PR · best: \(bestQualityModel ?? "—")"`
    (the cheapest's actual $/PR value plus the winner of the
    quality axis as context). When `bestQualityModel === null`,
    show `"$X.XX/PR"` only.
  - Row 2: `"most used: \(mostUsedModel ?? "—") (\(mostUsedPodCount ?? 0) pods)"`.
  - Sub-line suppressed entirely when `cohortSize === 0` (the
    value `—` carries the whole story).
- **isSelected / onClick:** unchanged from the existing pattern.

### Drill view — `ModelsDrillView`

Header (sticky inside the right-pane scroll):
- **Days picker:** numeric stepper or menu; default 30; values
  `7 / 14 / 30 / 60 / 90`. Re-fetches
  `/pods/analytics/models?days=N`.
- **Grain toggle:** segmented control with two values
  `Model | Runtime`. Default `Model`. When `Runtime`: the
  leaderboard table and comparison panel re-render against
  `byRuntime[]` instead of `byModel[]`. The failure-stage
  matrix and simulator STAY on `byModel[]` regardless of the
  toggle (per-model is the only useful grain for those — runtime
  is too coarse for stage-failure triage and the simulator's
  source/target dropdowns are model-keyed by design).

Body, in scroll order:

#### Section 1 — Leaderboard table (Brief 02)
Seven columns: model · pods · success rate · $/PR · avg
quality · mean TTM · escalation rate.

- Sort: server-supplied (`podCount DESC`, model ASC). Do not
  re-sort client-side.
- Display formatting:
  - `successRate`: `"\(Int(round(rate * 100)))%"`.
  - `dollarPerPr`: `"$\(formatTwoDecimals(value))"` or
    `"—"` when null.
  - `avgQuality`: `"\(Int(round(value)))"` (0..100 validator
    scale) or `"—"` when null.
  - `meanTtmSeconds`: re-use the duration formatter from
    `ThroughputDrillView` (`formatDuration` if exposed; else
    inline a `Xh Ym` style formatter).
  - `escalationRate`: `"\(Int(round(rate * 100)))%"`.
- Rows where `podCount < MIN_COHORT_FOR_HEADLINE` (5) render
  the model name with a smaller-text caption "n pods —
  low-signal" beneath; values are still shown but the operator
  is warned. The headline computations in the daemon already
  skip these rows.
- Empty state: `"No terminal pods in last N days."`.
- Stats-only — no row click, no expansion. (Per-pod drilldown
  lives in the existing Cost / Reliability cards.)

#### Section 2 — Side-by-side comparison panel (Brief 02)
Five horizontal bar groups, one per axis:
- Success rate (0..1, max axis = 1)
- $/PR (min observed → max observed, with sensible padding)
- Avg quality (0..100 validator scale)
- Mean TTM (min observed → max observed seconds)
- Escalation rate (0..1)

Each group renders one `BarMark` per `byModel[]` row (or
`byRuntime[]` when the grain toggle is on `Runtime`). Bar color
keyed by model/runtime — pick from a stable palette indexed by
position in the sorted array so colors are consistent across
sections in the same view-mount.

Skip rows where the axis value is `null` (don't render a
zero-height bar). The legend shows the model name plus its
color swatch.

Empty state: `"No comparable models in last N days."`.

#### Section 3 — Failure-stage matrix (Brief 02)
Table with N+1 columns (model + 8 stage columns) where each
cell shows `"\(podsFailed)/\(podsRan)"` with a colour ramp tied
to `failureRate` (0=neutral, 1=red — mirror the Reliability
profileHeatmap colour treatment if a shared helper exists; else
inline a simple linear interpolation).

Rows match `byModel[]` order (including `<unknown>` when
present). The `<unknown>` row renders the cells normally — we
can count its build/test failures even if we can't price its
pods.

Cells with `podsRan === 0` render as `"—"` (no data; don't draw
a green 0/0 cell that implies "no failures" when it really means
"never ran").

Empty state: `"No validations ran on any model in last N days."`.

Stats-only — no row click, no cell expansion.

#### Section 4 — What-if simulator (Brief 03)
Three controls in a vertical stack:
- **Source model dropdown:** populated from `byModel[]` where
  `model !== '<unknown>'` AND `podCount > 0`, sorted by `podCount
  DESC` (most-used first — the operator usually redirects FROM
  their volume model). Default: the most-used eligible model.
- **Target model dropdown:** same population. Default: the
  cheapest-$/PR eligible model. Cannot equal the source — when
  the source picker changes to match the target, the target
  auto-advances to the next eligible model (most-used after the
  new source).
- **Redirect slider:** 0–100% integer percentage, default 0%.
  Live-updates the projection on every tick (no debounce —
  recomputation is pure-Swift weighted-average math; cheap).

Below the controls, a 5-row "projection table" — one row per
comparison axis:

| Axis | Current | Projected | Delta |
|------|---------|-----------|-------|
| $/PR | $X.XX | $Y.YY | -$Z.ZZ |
| Avg quality | N | M | +Δ |
| Success rate | N% | M% | -Δpp |
| Mean TTM | Xh Ym | Yh Zm | -Wm |
| Escalation rate | N% | M% | +Δpp |

`Current` is the fleet-wide aggregate over the entire
`byModel[]` array (cohort-weighted average across all priced
models). `Projected` re-runs the same fleet-wide aggregate but
with `redirectFraction × source.podCount` pods reassigned to
target on each axis. Math details in Brief 03's Constraints.

Above the table, a persistent **caveat banner**: the text
`"Naïve projection — assumes target model performs identically
to its past terminal-cohort pods. Validate before committing."`
in caption-style smaller text, with a `!` glyph or similar
restrained warning treatment. Per ADR-023.

When the simulator is in default state (slider at 0%), the
"Projected" column equals "Current" and "Delta" is all zeros —
the operator can visually confirm the math by moving the slider
from 0 first.

Edge cases:
- Source has zero `completeCount` → cost / quality / TTM
  axes can't compute target-side contribution from source's
  complete pods alone; clamp the projection by treating the
  redirected slice as inheriting target's full per-pod
  averages weighted by the redirected `podCount`. Detail in
  Brief 03 math.
- Cohort contains unknown-model pods → exclude them from the
  fleet-wide $/PR calculation (their cost is `null`), but
  include them in success-rate / quality / TTM / escalation
  computations (those values exist for `<unknown>` rows too).
  Document this in the caveat banner verbatim or in a tooltip.
- Slider at 100% with `source.podCount` covering 80% of the
  cohort → the projection essentially shows what the fleet
  looks like with most pods on target. Math is unchanged;
  no special case.

Empty state for the section: when `byModel[]` has fewer than 2
priced models with non-zero podCount, show
`"Need ≥2 models with priced cohort pods to simulate."` and
hide the controls. The simulator IS the section's reason for
existing — no point rendering disabled dropdowns.

### Row-click navigation

This phase introduces **no row-click navigation**. The
leaderboard, comparison panel, failure-stage matrix, and
simulator are all stats-only. Per-pod drilldown for cost-related
questions lives in the existing Cost card (phase 1); for
reliability questions, in the Reliability card (phase 2). The
Models drill is a model-grain view of those same pods, not a
new entry into the pod detail panel.

## Reference reading

- `docs/analytics-dashboard-plan.md` Phase 6 — the seed; this
  spec realises it. The master plan flagged the server-side
  simulator endpoint as deferrable; this spec defers it
  (client-side only).
- `specs/analytics-shell/design.md` — `AnalyticsCard` API +
  right-pane scene state contract (consume as-is, do not widen).
- `specs/analytics-cost/design.md` — trailing-window +
  composite-endpoint conventions; `effectiveCostUsd(pod)` is the
  shared cost helper. Cost handles per-pod drilldown; this spec
  is the model-grain aggregate.
- `specs/analytics-reliability-funnel/design.md` — terminal
  cohort definition, aggregator placement, prior-window delta
  pattern, profileHeatmap (mirrored verbatim for
  failure-stage matrix), `SQLITE_MAX_VARIABLE_NUMBER` sub-query
  workaround.
- `specs/analytics-quality/design.md` — days picker UX,
  sticky-header drill pattern; `pod_quality_scores.score` is the
  quality source.
- `specs/analytics-throughput/design.md` — MTTM-as-mean precedent
  (`throughput-aggregator.ts:238`); leaderboard table layout
  precedent.
- `specs/analytics-escalations/design.md` — human-attention
  escalation predicate (mirrored verbatim for the escalation-rate
  axis); leaderboard small-N caption pattern.
- `packages/shared/src/pricing/index.ts` — `effectiveCostUsd`,
  `MODEL_PRICING`. Brief 01 extends this file with
  `MODEL_CANONICAL` + `canonicalModelKey`. ADR-015 is the prior
  decision; ADR-022 extends it.
- `packages/shared/src/types/runtime.ts` — `RuntimeType` union
  (claude / codex / copilot).
- `packages/shared/src/types/pod.ts` — `Pod.model` is `string`
  (free-form); coalescing must handle aliases.
- `packages/daemon/src/pods/reliability-aggregator.ts:101-185` —
  STAGES array + profileHeatmap accumulation pattern. Brief 01
  mirrors this.
- `packages/daemon/src/pods/reliability-aggregator.ts:240-310` —
  prior-window delta math, terminal-cohort sub-query pattern.
- `packages/daemon/src/pods/cost-aggregation.ts:91-94` —
  `byProfileModel` model-keyed rollup precedent.
- `packages/daemon/src/pods/cost-aggregation.ts:167` —
  `unknownModels` warn-logging precedent (extended in Brief 01
  to surface them on-wire).
- `packages/daemon/src/api/routes/pods.ts:244-256` — Reliability
  route registration pattern; copy the validation envelope and
  error shape.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ReliabilityDrillView.swift`
  — error-banner + per-section loading pattern; profileHeatmap
  rendering (template for the failure-stage matrix).
- `packages/desktop/Sources/AutopodUI/Views/Analytics/QualityDrillView.swift`
  — table-grain drill layout precedent.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ThroughputDrillView.swift`
  — duration formatter, mean-based stat treatment.
- `packages/desktop/Tests/AutopodClientTests/ReliabilityAnalyticsResponseTests.swift`
  — JSON-decode test scaffolding for the Codable mirror.
- `CLAUDE.md` "CRITICAL — migration numbering" — N/A this phase
  (no migration).
- 📋 ADR-015 (model pricing as bundled JSON) — direct prior; the
  pricing module is where `MODEL_CANONICAL` lives.
- 📋 ADR-016 (per-attempt phase token taxonomy) — forward-only
  data convention precedent; same applies here.
- 📋 ADR-018 (`safety_events` fleet-wide scope) — convention
  precedent that "fleet-wide" matters; this spec is also
  fleet-wide (not per-pod).

## Decisions

Two new ADRs introduced by this phase:

- **ADR-022 — MODEL_CANONICAL alias map.** `MODEL_PRICING`
  already carries short aliases (`opus`/`sonnet`/`haiku`) with
  duplicated pricing because `profile.defaultModel` can use
  short names. This works for pricing because the duplicate
  entries match. It does NOT work for analytics rollups: if a
  pod ships with `pods.model = 'opus'` and another with
  `pods.model = 'claude-opus-4-7'`, today they appear as two
  separate models with bisected stats. `MODEL_CANONICAL` is a
  one-way alias→canonical map exported from
  `packages/shared/src/pricing/index.ts` so every analytics path
  coalesces the same way. The map is additive: adding new
  aliases never breaks existing analytics paths.
- **ADR-023 — Client-side simulator with naïve weighted-average
  projection.** The master plan flagged the server-side
  `POST /pods/analytics/simulate` endpoint as deferrable and
  noted "Could also be done client-side; defer the call." We
  take that route. Brief 03 runs the simulator entirely in Swift
  off the aggregates Brief 01 already returns. The projection
  math is naïve: redirecting X% of source pods to target
  produces projected aggregates by weighted-averaging source and
  target's historical per-model means. This assumes future pods
  on the target model perform identically to past terminal-cohort
  pods on the target model — a known false assumption
  (selection bias: the easier work may already route there). The
  UI flags the assumption with a persistent caveat banner. The
  ADR records why we accept the false-assumption tradeoff (the
  signal is "rough order-of-magnitude direction", not
  "production capacity-planning model"; a per-pod
  hardness-controlled counterfactual is its own multi-month
  research project).

Other load-bearing choices, mechanically derived (no ADR
needed):

- Terminal cohort: identical to Phase 1/2/5a/5b; convention is
  "Phase 1 set this; later phases honour it."
- Headline = cheapest $/PR MODEL NAME, not the cents value.
  Operator picks the model first, then drills for the value.
  The drill carries the full leaderboard with the actual $/PR
  numbers.
- Sub-line content: "$X/PR · best: <best-quality-model>" and
  "most used: <model> (N pods)". Carries the master plan's three
  axes (cheapest / best-quality / most-used) on the card.
- MIN_COHORT_FOR_HEADLINE = 5. Matches phase 5b's per-profile
  fold-in threshold. Avoids "Opus has the best quality at score
  100 across its single test pod" noise.
- Unknown-model handling: bucketed under `<unknown>` in
  `byModel[]` + `failureStageMatrix[]`; surfaced separately in
  `unknownModels[]`. Excluded from cost axes (we can't price
  them) but included in volume / quality / TTM / escalation.
- TTM = mean (not median) — matches `throughput-aggregator.ts:238`
  and is required for the simulator to weighted-average it
  cleanly. The master plan literal phrasing said "median" but
  the simulator math forces mean; the operator cares about
  cross-phase consistency more than the literal phrasing.
- Escalation rate predicate identical to phase 5b's
  `HumanAttentionKind`. No re-litigating the scope.
- Failure-stage matrix shape = reliability's `profileHeatmap`
  pattern verbatim, keyed by canonical model instead of profile.
- Single endpoint (composite) per card — matches Phases
  1/2/3/4/5a/5b. Rejected alternative: separate endpoints for
  leaderboard / matrix / simulator-aggregates. Would have
  multiplied HTTP calls 3× without latency benefit.
- Simulator on the client (not the server). Per ADR-023.
- Simulator is one global rule (source / target / %), not
  per-profile. Per the non-goal section.
- Simulator projects all 5 comparison axes (cost, quality,
  success, mean TTM, escalation rate). Maximum signal; UX is
  one repeated row pattern.
- Card sparkline = daily pod count of the MOST-USED model. Other
  shapes considered: total cohort daily count (already in the
  Throughput card); stacked per-model counts (too noisy for a
  card-grid sparkline). Most-used-only is the cleanest "is my
  workhorse model staying steady" signal.
- Delta direction threshold: 0.5 cents (0.005 USD) — same
  numerical sensitivity as escalations' rate-delta threshold
  but applied to dollars instead of fraction.
- No `web` ACs on Brief 02 + Brief 03 — same precedent as every
  prior analytics phase (native macOS profile, no web UI). Test
  expectations + diff reviewer carry the load.

ADRs reused:
- ADR-015: Model pricing as bundled JSON (the pricing module is
  the host for `MODEL_CANONICAL`).
- ADR-016: Per-attempt phase token taxonomy — forward-only data
  convention.
- ADR-018: `safety_events` fleet-wide scope — fleet-wide
  analytics convention precedent.
