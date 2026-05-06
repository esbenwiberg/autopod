# Handover — rubber-tortoise (Brief 03: Endpoint Seam)

## What was built

Added the cost analytics endpoint and all supporting aggregation logic.

**Files created:**

- `packages/shared/src/types/analytics.ts` — `CostAnalyticsResponse` interface with all
  seven fields: `total`, `sparkline`, `deltaVsPrior`, `byPhase`, `byProfileModel`, `top10`,
  `waste`.
- `packages/daemon/src/pods/cost-aggregation.ts` — exports `aggregateCost()`,
  `parseDays()`, and the supporting interfaces `CostAggregationDeps` /
  `CostAggregationOptions`. Pure synchronous function; injectable `now` clock for tests.
- `packages/daemon/src/pods/cost-aggregation.test.ts` — 27 unit tests covering all
  specified scenarios (empty DB, boundary conditions, effective-cost paths, byPhase
  ordering, agent_legacy reconstruction, waste filter, top10 limit, workspace and
  non-terminal exclusion, deltaVsPrior thresholds) plus `parseDays` tests.

**Files modified:**

- `packages/shared/src/index.ts` — added `export type { CostAnalyticsResponse }` line.
- `packages/daemon/src/api/routes/pods.ts` — registered
  `GET /pods/analytics/cost` adjacent to `/pods/quality/trends` and `/pods/scores`;
  added `import { aggregateCost, parseDays }` at top.
- `packages/daemon/src/integration.test.ts` — promoted `const podRepo` to outer `let`
  scope and added it to `createServer()`; added `describe('Cost analytics')` block with 6
  integration tests.

## Deviations from brief

None. The brief was followed exactly.

## Interfaces and contracts Brief 04 must know

### `CostAnalyticsResponse` (packages/shared/src/types/analytics.ts)

Exact shape matches `design.md` → Contracts → Cost analytics response. Stable.

### Endpoint

```
GET /pods/analytics/cost?days=N
  200 → CostAnalyticsResponse (sparkline.length === N; default N=30)
  400 → { error, code: 'invalid_days' } for non-positive-integer days
  503 → { error } if podRepo not wired (never happens in prod; test harness guard only)
```

### `parseDays()` behaviour

- `undefined`/`null` → 30
- Digit-only positive integer string → that integer
- Zero, negative, decimal, non-numeric → null (signals 400)

### Key aggregation invariants Brief 04 relies on

- **Sparkline length** always equals `days` from the query. Every element is present; days
  with no pods have `costUsd: 0`.
- **`byPhase` ordering**: `agent_initial` → `agent_rework_N` (numeric sort) →
  `review` → `plan_eval` → `agent_legacy`. Segments with `costUsd === 0` are omitted.
- **`agent_legacy`**: synthetic bucket for the gap between `effectiveCostUsd(pod)` and
  the sum of computed phase bucket costs. Pre-Phase-1 pods with no `phaseTokenUsage`
  have their entire cost here.
- **Workspace pods excluded**: `pod.options.agentMode === 'interactive'`.
- **Terminal statuses filtered**: `complete`, `killed`, `failed`, `rejected`.
- **Waste**: only `killed`, `failed`, `rejected` — not `complete`.
- **`deltaVsPrior.direction`**: `up` when current > prior × 1.05; `down` < prior × 0.95;
  `flat` otherwise. Edge case: prior = 0 and current > 0 → `up`.

## Files Brief 04 must NOT modify without good reason

- `packages/shared/src/types/analytics.ts` — the contract Brief 04 decodes in Swift.
- `packages/daemon/src/pods/cost-aggregation.ts` — the aggregation logic is stable.
- `packages/daemon/src/api/routes/pods.ts` — only touch to add unrelated routes; do not
  change the cost route signature.

## Constraints and landmines

- **`podRepo.list()` has no date-range filter** — the aggregation fetches all pods and
  filters in-memory. This is intentional (operator-grade scale); do not add a new
  repo method.
- **`rejected` pod status**: The `PodStatus` TypeScript union does not include
  `'rejected'`, but it is a real runtime value that exists in the DB (written by
  pod-manager when a human rejects a pod). `TERMINAL_STATUSES` and `WASTE_STATUSES` use
  raw `Set<string>` so they match it correctly at runtime. Do not "fix" this by
  switching to `isTerminalState()` from state-machine.ts — that function only covers
  `complete | killed | failed` and would silently drop rejected pods.
- **`effectiveCostUsd()` is called once per pod** and cached in `costById` during the
  main loop. The top10 sort and waste total read from this cache — do not re-introduce
  redundant calls.
- **`agent_rework_N` key ordering**: Sort numerically by parsing the suffix. Object.keys()
  order is insertion-order but is NOT reliable after JSON round-trips. Always sort
  explicitly.
- **`console.warn` for unknown models / phase keys**: Warns once per aggregation call
  (deduped via Set). This is intentional — single warn per request per the spec.
