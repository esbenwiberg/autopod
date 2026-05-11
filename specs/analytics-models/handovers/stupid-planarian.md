# Handover — stupid-planarian (Brief 01)

## What was built

- `GET /pods/analytics/models?days=N` route on the daemon (default 30, max 365)
- `packages/daemon/src/pods/models-aggregator.ts` — pure aggregator function returning the full `ModelsAnalyticsResponse` payload
- `packages/shared/src/pricing/index.ts` — added `MODEL_CANONICAL` alias map and `canonicalModelKey()` helper (ADR-022)
- `packages/shared/src/types/analytics.ts` — added `ValidationStage`, `FailureStageCell`, `FailureStageRow`, `PerModelAggregate`, `PerRuntimeAggregate`, `UnknownModelSample`, `ModelsSummary`, `ModelsAnalyticsResponse`
- `packages/shared/src/index.ts` — re-exports all 8 new types
- 26 unit tests in `models-aggregator.test.ts`, 6 route tests appended to `pods.test.ts`

## Contract

`ModelsAnalyticsResponse` is the wire contract. It lives in `packages/shared/src/types/analytics.ts` and is re-exported from `packages/shared/src/index.ts`. Brief 02 must mirror this verbatim in Swift.

Key fields to be aware of:

- `summary.cheapestDollarPerPrDelta.value` is in **absolute USD** (e.g. -0.42 = $0.42 cheaper), NOT percent. Desktop formats as `%+$.2f/PR`.
- `byRuntime[]` always has exactly **3 entries** in `claude / codex / copilot` order — zero-pod runtimes emit rows with `podCount: 0`. Desktop relies on this fixed shape.
- `byModel[]` includes a `<unknown>` row when unpriced-model pods are in the cohort. Its `totalCostUsd`, `dollarPerPr`, and `completeCostUsd` are `null`. All other axes (quality, TTM, escalation, failure-stage) are computed normally.
- `unknownModels[]` length is capped at 10 (raw string → podCount pairs).
- `completeCostUsd` (per model) is cost from `status='complete'` pods only — needed by Brief 03's simulator for weighted-average projection.
- `MIN_COHORT_FOR_HEADLINE = 5` applies only to the cheapest-$/PR and best-quality headline picks in `summary`. All models still appear in `byModel[]`.

## Deviations from brief

None. The brief said to inline `terminalCohortWhere()` with a sync comment if not yet extracted — followed exactly, as the other aggregators also inline it.

## Files not to modify

- `packages/daemon/src/pods/models-aggregator.ts` — owns the aggregation logic; Brief 02 consumes its output, not its internals
- `packages/shared/src/types/analytics.ts` — the Swift Codable mirror in Brief 02 must match this exactly; any field additions/renamings break the mirror
- `packages/shared/src/pricing/index.ts` — `MODEL_CANONICAL` is the canonical alias map; do not add new aliases without also checking the MODEL_PRICING keys they map to

## Landmines / constraints for downstream pods

1. **`canonicalModelKey()` checks MODEL_CANONICAL FIRST, then MODEL_PRICING.** Short aliases like `opus` also exist as direct keys in MODEL_PRICING (duplicated for pricing purposes). If the check order were reversed, `canonicalModelKey('opus')` would return `'opus'` instead of `'claude-opus-4-7'`, bisecting stats. The current order is intentional and tested.

2. **Validation result parsing reads the `result` JSON blob, not separate stage/passed columns.** The `validations` table stores a `result` TEXT column containing a nested JSON object (mirroring `reliability-aggregator.ts`). The brief's SQL pseudocode suggested separate columns but the actual schema uses JSON.

3. **`createTestDb()` returns a `Database.Database` directly** (synchronous, no wrapping object, no `.db` property). Tests import it as `db = createTestDb()`.

4. **`pod_quality_scores` schema:** Primary key is `pod_id` (no separate `id` column). Required NOT NULL columns: `runtime`, `profile_name`, `model`, `final_status`, `completed_at`. No `signals` column. Use the `insertQuality()` helper in `models-aggregator.test.ts` as a template.

5. **Prior-window delta direction:** `'down'` on $/PR means cheaper (good). The JSON does not encode the semantic — desktop is responsible for colour treatment. Threshold: ±$0.005.
