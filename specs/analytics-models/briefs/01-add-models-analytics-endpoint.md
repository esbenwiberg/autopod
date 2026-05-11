---
title: "Add models analytics endpoint"
acceptance_criteria:
  - type: api
    outcome: GET /pods/analytics/models?days=30 → 200 with body.summary.cohortSize (number), body.summary.cheapestDollarPerPrDelta, body.summary.mostUsedDailySparkline (array, length 30), body.byModel (array), body.byRuntime (array, length 3), body.failureStageMatrix (array), body.unknownModels (array, length <= 10)
    hint: GET /pods/analytics/models?days=30
  - type: api
    outcome: GET /pods/analytics/models?days=0 → 400 with body.code = 'invalid_days'
    hint: GET /pods/analytics/models?days=0
  - type: api
    outcome: GET /pods/analytics/models?days=400 → 400 with body.code = 'invalid_days'
    hint: GET /pods/analytics/models?days=400
touches:
  - packages/daemon/src/pods/models-aggregator.ts
  - packages/daemon/src/pods/models-aggregator.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/index.ts
  - packages/shared/src/types/analytics.ts
  - packages/shared/src/index.ts
  - packages/shared/src/pricing/index.ts
does_not_touch:
  - packages/desktop/
  - packages/cli/
  - packages/escalation-mcp/
  - packages/validator/
  - packages/daemon/src/db/migrations/
  - packages/shared/src/pricing/model-pricing.json
---

## Task

Add `GET /pods/analytics/models?days=N` on the daemon. Pure
read/aggregate path — no schema, no writers, no new persistence.
Returns one composite payload covering the headline cheapest-$/PR
model + best-quality model + most-used model, a per-model
leaderboard, a per-runtime rollup, a per-model × per-stage
failure matrix, and a list of unrecognised model strings.

The full endpoint shape lives in `design.md` → Contracts.
Implement exactly that shape; do not widen it; do not invent new
fields.

This brief also introduces `MODEL_CANONICAL` + `canonicalModelKey`
in `packages/shared/src/pricing/index.ts`. ADR-022 documents the
decision. Do NOT modify `model-pricing.json` (the JSON is the
price catalog; the canonical map is code, not data).

### Brief overview of the work

1. **MODEL_CANONICAL alias map** — extend
   `packages/shared/src/pricing/index.ts`:
   ```ts
   /** Maps short / legacy model aliases to their canonical
    *  MODEL_PRICING key so analytics rollups don't bisect stats
    *  for what is the same model. See ADR-022. */
   export const MODEL_CANONICAL: Readonly<Record<string, string>> = {
     opus: 'claude-opus-4-7',
     sonnet: 'claude-sonnet-4-6',
     haiku: 'claude-haiku-4-5',
   };

   /** Resolve a raw model string to its canonical MODEL_PRICING
    *  key. Returns null if the model is neither a direct
    *  MODEL_PRICING key nor a known alias. */
   export function canonicalModelKey(
     model: string | null | undefined,
   ): string | null {
     if (!model) return null;
     if (model in MODEL_PRICING) return model;
     const aliased = MODEL_CANONICAL[model];
     if (aliased && aliased in MODEL_PRICING) return aliased;
     return null;
   }
   ```
   The map is additive — adding entries never breaks existing
   analytics paths. Keep it in sync with the alias keys in
   `model-pricing.json` (today: `opus`, `sonnet`, `haiku`).

2. **Shared types** — extend
   `packages/shared/src/types/analytics.ts` with `ValidationStage`
   (or import from a shared location if it gets extracted; today
   it's local to `reliability-aggregator.ts` and may need
   duplicating until that's lifted), `FailureStageCell`,
   `FailureStageRow`, `PerModelAggregate`, `PerRuntimeAggregate`,
   `UnknownModelSample`, `ModelsSummary`,
   `ModelsAnalyticsResponse`. Re-export from
   `packages/shared/src/index.ts`. If `ValidationStage` is already
   exported through `@autopod/shared` (check
   `packages/shared/src/types/validation.ts` first), reuse the
   existing export — don't duplicate.

3. **Aggregator** — new
   `packages/daemon/src/pods/models-aggregator.ts`. Co-located
   with `reliability-aggregator.ts`,
   `throughput-aggregator.ts`, and `escalations-aggregator.ts`.
   Export a `computeModelsAnalytics(db, days): ModelsAnalyticsResponse`
   that runs the queries and assembles the response.

   One cohort (terminal cohort, see `design.md` → Cohort
   discipline). Four queries, all joined on `cohort`:
   - Pods themselves — for `byModel`, `byRuntime`,
     `unknownModels`, the most-used-daily sparkline, the
     prior-window delta.
   - `pod_quality_scores` — for `avgQuality` per model + per
     runtime.
   - `escalations` (filtered by `HumanAttentionKind` predicate
     identical to phase 5b's) — for `escalatedCount` per model
     + per runtime.
   - `validations` — for the failure-stage matrix.

   Helper math (full SQL examples in `design.md`):

   - Coalesce every `pods.model` via
     `canonicalModelKey(rawModel) ?? '<unknown>'` on the way out
     of the cohort query.
   - For each pod: bump `byModel[canonical].podCount`,
     `byRuntime[pod.runtime].podCount`, then status-specific
     counters and accumulators.
   - `successRate = completeCount / podCount`.
   - `dollarPerPr = (completeCount > 0 && canonical !== '<unknown>') ? totalCostUsd / completeCount : null`.
     The `<unknown>` bucket carries
     `totalCostUsd: null, dollarPerPr: null, completeCostUsd: null`.
   - `totalCostUsd` per model = `SUM(effectiveCostUsd(pod))` over
     ALL statuses (waste counts).
   - `completeCostUsd` per model = same sum but only for
     `status='complete'`. Required by Brief 03's simulator.
   - `meanTtmSeconds = (completeCount > 0) ? sumTtmSeconds / completeCount : null`,
     where ttm = `(julianday(completed_at) - julianday(created_at)) * 86400`
     for `status='complete'` only.
   - `avgQuality = (scoredCount > 0) ? scoreSum / scoredCount : null`,
     from `pod_quality_scores` joined on cohort.
   - `escalatedCount` = distinct cohort pod IDs where the pod
     has ≥1 escalation row with `type IN ('ask_human',
     'report_blocker','validation_override','action_approval')`.
     `escalationRate = escalatedCount / podCount`.
   - `byRuntime[]` emits exactly 3 entries (`claude`, `codex`,
     `copilot`) in that fixed order. Zero-pod runtimes still emit
     a row with `podCount: 0` and null averages. The runtime
     rollup is **not** coalesced — runtime is a closed enum, not
     a free-form string.
   - `byModel[]` sorted by `podCount DESC`, ties by `model ASC`.
     The `<unknown>` bucket sorts naturally.
   - `failureStageMatrix[]` — one row per canonical model
     appearing in `byModel[]` (including `<unknown>` if
     present). Each row carries all 8 stages in the fixed
     STAGES order with `{ podsRan, podsFailed, failureRate }`.
     Mirror `reliability-aggregator.ts`'s
     `emptyProfileStageMap` + accumulation pattern verbatim,
     keyed by canonical model.
   - `unknownModels[]` — distinct `rawModel` strings that
     coalesced to `<unknown>`, grouped with podCount, sorted by
     `podCount DESC` then `rawModel ASC`, `LIMIT 10`. Empty
     array when every pod's model resolved.
   - `summary.cheapestDollarPerPrModel` — canonical model name
     of the `byModel[]` row with the lowest non-null
     `dollarPerPr` where `completeCount >= MIN_COHORT_FOR_HEADLINE`
     (constant `5`) AND `model !== '<unknown>'`. Null when no
     row qualifies.
   - `summary.cheapestDollarPerPr` — that row's `dollarPerPr`
     value, or null when no eligible row.
   - `summary.bestQualityModel` — canonical model name with the
     highest non-null `avgQuality` where
     `scoredCount >= MIN_COHORT_FOR_HEADLINE` AND
     `model !== '<unknown>'`. Null when no row qualifies.
   - `summary.bestQuality` — matching `avgQuality` value, or
     null.
   - `summary.mostUsedModel` — canonical model name with the
     highest `podCount`. No `MIN_COHORT_FOR_HEADLINE` gate. May
     be `<unknown>` when unpriced-model pods dominate. Null when
     `cohortSize === 0`.
   - `summary.mostUsedPodCount` — matching podCount value, or
     null.
   - `summary.cohortSize` — total distinct terminal-cohort pods.
   - `summary.mostUsedDailySparkline` — bucket cohort pods by
     `date(completed_at)` UTC daily, count only those whose
     coalesced model equals `mostUsedModel`. Length === days,
     pad missing days with `count: 0`. Empty cohort (no
     `mostUsedModel`) → all-zero sparkline.
   - `summary.cheapestDollarPerPrDelta` — run the cheapest-$/PR
     computation against the immediately-prior window of
     identical length (mirror
     `reliability-aggregator.ts:248-263`). Direction: `down` if
     `value < -0.005`, `up` if `> 0.005`, else `flat`. When
     either window has `cheapestDollarPerPr === null`, emit
     `{ value: 0, direction: 'flat' }`. Note the sign convention:
     "down" on $/PR is GOOD (cheaper); the JSON does not encode
     that — desktop is responsible for the colour semantic.

4. **Route registration** — extend
   `packages/daemon/src/api/routes/pods.ts`. Mirror the
   Reliability route at `pods.ts:244-256`. Validation envelope
   and error shape per `design.md` → Validation rules. The
   handler calls `computeModelsAnalytics(db, days)`.

5. **Wiring** — `packages/daemon/src/index.ts` passes the
   aggregator into the route registration alongside the existing
   reliability / quality / cost / safety / throughput /
   escalations wiring.

## Touches

- `packages/shared/src/pricing/index.ts` — add
  `MODEL_CANONICAL` + `canonicalModelKey`.
- `packages/shared/src/types/analytics.ts` — add new types.
- `packages/shared/src/index.ts` — re-export.
- `packages/daemon/src/pods/models-aggregator.ts` — new
  aggregator.
- `packages/daemon/src/pods/models-aggregator.test.ts` —
  co-located unit tests.
- `packages/daemon/src/api/routes/pods.ts` — register the new
  route.
- `packages/daemon/src/api/routes/pods.test.ts` — extend with
  route integration tests.
- `packages/daemon/src/index.ts` — wire the aggregator.

## Does not touch

- `packages/desktop/` — desktop consumes this contract in Brief
  02.
- `packages/cli/` — no CLI surface for models analytics.
- `packages/escalation-mcp/`, `packages/validator/` — unrelated.
- `packages/daemon/src/db/migrations/` — no schema change in
  this phase.
- `packages/shared/src/pricing/model-pricing.json` — the price
  catalog stays separate from the canonical alias map (one is
  data, one is code).

## Constraints

- Follow `design.md` → Contracts verbatim. Do not widen the
  response.
- One terminal cohort. All sections in this endpoint are
  cohort-pinned (unlike phase 5b's three-cohort split). Reuse
  `buildTerminalCohortClause(days)` from prior aggregators; if
  the helper isn't extracted yet, inline the predicate
  identically and add a `// keep in sync with: ...` comment.
- Alias coalescing happens in JS via `canonicalModelKey`, not in
  SQL. Every per-model rollup keys by the coalesced value.
- The `<unknown>` bucket is a real `byModel[]` row when there
  are unpriced-model pods. It carries cost as null but all
  volume / quality / TTM / escalation values are computed
  normally. The same row appears in `failureStageMatrix[]`.
- `byRuntime[]` always emits exactly 3 entries in
  `claude / codex / copilot` order. No coalescing — runtime is a
  closed enum from `RuntimeType`.
- `MIN_COHORT_FOR_HEADLINE = 5`. Local constant in the
  aggregator (mirrors phase 5b's per-profile fold-in threshold).
  Models below this threshold still appear in `byModel[]` (just
  excluded from the cheapest-$/PR and best-quality headline
  determinations).
- `unknownModels[]` length always ≤ 10. Sort by `podCount DESC`,
  then `rawModel ASC`. Do not expose more than 10 — the list is
  a "should I add this to the pricing catalog?" prompt, not an
  audit log.
- Quality requires `pod_quality_scores`. Pods without a quality
  row are excluded from BOTH the `scoreSum` numerator AND the
  `scoredCount` denominator (don't divide by `podCount`).
  `scoredCount` is exposed so the desktop can render an
  honest small-N caption.
- TTM is MEAN, not median. Cross-phase consistency with
  `throughput-aggregator.ts:238` and required for the simulator
  to weighted-average it in Brief 03.
- Cost waste counts: `totalCostUsd` includes
  `status='killed'` and `'failed'` pods. `dollarPerPr` divides
  that total by `completeCount` only. `completeCostUsd` is
  exposed separately for the simulator (cost contribution from
  *complete* pods only — answers "if we'd redirected the source's
  complete pods to target, what does target cost?").
- Use the sub-query pattern from
  `reliability-aggregator.ts:268-275` to avoid hitting
  `SQLITE_MAX_VARIABLE_NUMBER` on large cohorts.
- `ValidationStage` is exactly the 8 values in
  `reliability-aggregator.ts:22-30`. Do not invent new stages;
  rows with stages outside the union are silently dropped from
  the matrix (mirrors reliability's behaviour).
- The escalation-rate predicate is exactly
  `type IN ('ask_human','report_blocker','validation_override','action_approval')`
  — identical to phase 5b's `HumanAttentionKind`. Do not silently
  widen.
- The `summary.cheapestDollarPerPrDelta.value` is in absolute
  USD (e.g. -0.42 means $0.42 cheaper). Document this in the
  aggregator comment so Brief 02 formats it correctly.

## Test expectations

`models-aggregator.test.ts`:

- **Empty cohort** — returns
  `summary.cheapestDollarPerPrModel: null, cheapestDollarPerPr: null, bestQualityModel: null, bestQuality: null, mostUsedModel: null, mostUsedPodCount: null, cohortSize: 0`,
  `mostUsedDailySparkline` of length `days` all zero,
  `cheapestDollarPerPrDelta: { value: 0, direction: 'flat' }`,
  empty `byModel`, `byRuntime` of length 3 each with
  `podCount: 0`, empty `failureStageMatrix`, empty
  `unknownModels`.

- **Single-model cohort** — fixture: 10 pods all on
  `claude-opus-4-7`, 7 complete, 2 killed, 1 failed, total cost
  $30, 5 with quality scores averaging 80. Assert
  `byModel.length === 1`, `byModel[0].model === 'claude-opus-4-7'`,
  `podCount === 10, completeCount === 7, killedCount === 2, failedCount === 1`,
  `successRate === 0.7`, `totalCostUsd ≈ 30`,
  `dollarPerPr ≈ 30 / 7`, `scoredCount === 5, avgQuality === 80`.
  Summary: cheapest = opus, best-quality = opus, most-used = opus.

- **Alias coalescing** — fixture: 6 pods with `pods.model = 'opus'`,
  4 pods with `pods.model = 'claude-opus-4-7'`. Assert
  `byModel.length === 1`, `byModel[0].model === 'claude-opus-4-7'`,
  `podCount === 10`. The `opus` string never appears in the
  response.

- **Unknown model bucket** — fixture: 5 pods with
  `pods.model = 'mystery-model-x'` and 5 pods on Opus. Assert
  `byModel.length === 2`, one row with
  `model === '<unknown>', podCount === 5, totalCostUsd === null,
  dollarPerPr === null, completeCostUsd === null` and another
  with `model === 'claude-opus-4-7'`. Assert
  `unknownModels === [{ rawModel: 'mystery-model-x', podCount: 5 }]`.
  Quality / TTM / escalation values still compute for the
  unknown row.

- **Unknown models cap at 10** — fixture: 12 distinct unrecognised
  model strings, each on a single pod. Assert
  `unknownModels.length === 10`, ordered by `podCount DESC` then
  `rawModel ASC`. The `<unknown>` bucket's `podCount === 12`
  (all 12 pods bucket together regardless of the per-string
  cap).

- **MIN_COHORT_FOR_HEADLINE excludes small models from cheapest**
  — fixture: Haiku has 3 pods at $0.10/PR, Opus has 100 pods at
  $5/PR. Assert
  `summary.cheapestDollarPerPrModel === 'claude-opus-4-7'`
  (Haiku ineligible due to `completeCount < 5`). The Haiku row
  still appears in `byModel[]`.

- **MIN_COHORT_FOR_HEADLINE excludes small models from
  best-quality** — fixture: Haiku has 2 scored pods at quality
  95, Opus has 50 scored pods at quality 80. Assert
  `summary.bestQualityModel === 'claude-opus-4-7'` and
  `summary.bestQuality === 80`.

- **Most-used has no MIN_COHORT gate** — fixture: only one
  model in the cohort with `podCount = 2`. Assert
  `summary.mostUsedModel` matches that model with
  `mostUsedPodCount === 2`, even though it's below the headline
  threshold.

- **Most-used can be `<unknown>`** — fixture: 8 unknown-model
  pods + 3 Opus pods. Assert
  `summary.mostUsedModel === '<unknown>'`. (Desktop decides how
  to render that.)

- **byRuntime always length 3** — fixture: every pod on
  `runtime='claude'`. Assert `byRuntime.length === 3` with
  entries in order `claude / codex / copilot`. The `codex` and
  `copilot` rows have `podCount: 0` and null averages.

- **TTM mean math** — fixture: 3 complete pods with TTMs of
  60s, 300s, 600s on the same model. Assert
  `meanTtmSeconds === 320` (mean of 60, 300, 600).

- **TTM excludes non-complete pods** — fixture: 1 complete pod
  TTM 60s, 1 killed pod created+completed in window. Assert
  `meanTtmSeconds === 60`, not the average across both.

- **Quality excludes pods without a quality row** — fixture: 10
  cohort pods, 3 with `pod_quality_scores` rows scoring 60, 70,
  80. Assert `scoredCount === 3, avgQuality === 70`. The other
  7 pods don't pollute the average.

- **Cost waste in totalCostUsd, not in dollarPerPr** — fixture:
  1 complete pod at $5, 1 killed pod at $3. Assert
  `totalCostUsd === 8, dollarPerPr === 8 / 1 === 8` (killed pod
  cost in numerator, not in denominator).

- **completeCostUsd separates waste** — same fixture. Assert
  `completeCostUsd === 5` (only the complete pod's cost
  contributes).

- **Escalation rate predicate** — fixture: 10 cohort pods, 3
  with `ask_human`, 1 with `validation_override`, 1 with
  `ask_ai` (excluded), 1 with `request_credential` (excluded).
  Assert `escalatedCount === 4, escalationRate === 0.4`.

- **Escalation rate distinct-pod** — fixture: 1 pod with 5
  `ask_human` rows in cohort. Assert `escalatedCount === 1`
  (distinct), not 5.

- **Failure-stage matrix shape** — fixture: 2 canonical models
  in cohort. Assert `failureStageMatrix.length === 2`, each row
  has `stages.length === 8` in the fixed STAGES order.

- **Failure-stage matrix coalescing** — fixture: 2 pods with
  `pods.model='opus'`, 3 with `'claude-opus-4-7'`, both running
  the `build` stage with mixed results. Assert
  `failureStageMatrix` has a single row with
  `model === 'claude-opus-4-7'` summing across both raw model
  strings.

- **Failure-stage podsRan === 0 cells** — fixture: model X never
  runs the `sast` stage. Assert
  `matrix[X].stages[stage='sast'] === { podsRan: 0, podsFailed: 0, failureRate: 0 }`
  (not omitted, not null).

- **Sparkline most-used-only** — fixture: 5 Opus pods completing
  on day 1, 3 Sonnet pods completing on day 2. Assert
  `mostUsedDailySparkline[0].count === 5` (Opus is most-used)
  and `mostUsedDailySparkline[1].count === 0` (Sonnet doesn't
  contribute).

- **Sparkline length matches days** — fixture with `days=7`.
  Assert `mostUsedDailySparkline.length === 7`, padded with
  `count: 0` on days without pods.

- **Trailing-window predicate** — fixture with pods just-inside
  and just-outside the 30-day window; outside-window pods don't
  appear in any section.

- **Workspace exclusion** — fixture with one pod
  `output_mode='workspace'`. Pod is excluded from EVERY section
  (cohort, byModel, byRuntime, failureStageMatrix, unknownModels,
  sparkline).

- **Prior-window delta** — fixture: current 30-day window
  cheapest = $1.20/PR; prior 30-day window cheapest = $1.50/PR.
  Assert
  `cheapestDollarPerPrDelta.value ≈ -0.30, direction === 'down'`.

- **Prior-window null** — fixture: current window has a
  cheapest model; prior window has no eligible model. Assert
  `cheapestDollarPerPrDelta === { value: 0, direction: 'flat' }`.

`pods.test.ts` (route-level, mirror Reliability block):

- Default behaviour (`/pods/analytics/models` with no `days`)
  uses `days=30`; structural assertion on the response shape
  (every required key present, expected lengths).
- `?days=0` → 400 with `code: 'invalid_days'`.
- `?days=-5` → 400 with `code: 'invalid_days'`.
- `?days=400` → 400 with `code: 'invalid_days'`.
- `?days=abc` → 400 with `code: 'invalid_days'`.
- `?days=90` (boundary) → 200, sparkline length 90,
  `byRuntime` length 3.

`pricing/index.test.ts` (if it exists, else co-locate new tests
in `packages/shared/src/pricing/index.test.ts`):

- `canonicalModelKey('opus') === 'claude-opus-4-7'`.
- `canonicalModelKey('claude-opus-4-7') === 'claude-opus-4-7'`.
- `canonicalModelKey('mystery') === null`.
- `canonicalModelKey(null) === null`.
- `canonicalModelKey(undefined) === null`.
- `canonicalModelKey('') === null`.

## Risks / pitfalls

- **Coalescing only in JS** — never write
  `GROUP BY pods.model` in SQL for these rollups; that would
  bisect Opus pods between `opus` and `claude-opus-4-7`. Pull raw
  rows and group in JS after coalescing.
- **`<unknown>` row pollution in cost axes** — if you forget to
  null-guard the `<unknown>` row's `totalCostUsd / dollarPerPr`,
  the headline cheapest-$/PR calculation will silently pick
  `<unknown>` (since unpriced pods cost $0 → cheapest). The
  contract specifies null for these; the headline calc must
  skip nulls AND filter `model !== '<unknown>'` defensively.
- **`MIN_COHORT_FOR_HEADLINE` applied inconsistently** — the
  threshold applies to the cheapest-$/PR and best-quality
  HEADLINE determinations only. The `byModel[]` table includes
  ALL models regardless of size; the desktop renders a small-N
  caption. Don't filter the table.
- **byRuntime fixed-length emission** — even when no pods on a
  runtime, emit a row with `podCount: 0`. The desktop relies on
  the fixed 3-entry shape for the runtime-grain toggle.
- **`pod_quality_scores` left-join semantics** — the quality
  query joins on cohort; pods without a quality row simply
  don't appear in the join. Don't `COALESCE(score, 0)` — that
  would falsely lower averages.
- **Mean TTM versus phase-6 master plan literal phrasing** —
  the master plan said "median time-to-merge". This spec
  deliberately uses mean for cross-phase consistency (matches
  throughput-aggregator's MTTM) AND because the Brief 03
  simulator cannot weighted-average a median. The decision is
  documented in `design.md` → Decisions; reviewers should
  understand the trade.
- **Variable-number limit** — `SQLITE_MAX_VARIABLE_NUMBER`
  defaults to 999. Cohort sizes can exceed that. Use the
  sub-query pattern from `reliability-aggregator.ts:268-275` for
  any `WHERE pod_id IN (...)` — pass the cohort filter as a
  sub-query, not spread params.
- **ValidationStage filtering** — the `validations` table can
  carry stages outside the 8-value union (legacy / new stages
  in flight). Silently drop rows with unknown stages (matches
  reliability's behaviour). Don't throw.
- **Delta arithmetic on USD** — prior-window delta is in
  absolute USD (e.g. -0.42 means $0.42 cheaper). NOT percent.
  Document in the aggregator comment so Brief 02 formats with
  `%+$.2f/PR`, not `%+0.2f%%`.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
