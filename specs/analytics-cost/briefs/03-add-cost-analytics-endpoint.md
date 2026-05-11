---
title: "Add GET /pods/analytics/cost endpoint with composite aggregation"
depends_on: [ 02-instrument-per-attempt-phase-tokens ]
acceptance_criteria:
  - type: api
    outcome: GET /pods/analytics/cost (no params) → 200 with body.total (number), body.sparkline (array length 30), body.byPhase (array), body.byProfileModel (array), body.top10 (array length <= 10), body.waste.total (number), body.waste.podCount (integer), body.deltaVsPrior.value (number), body.deltaVsPrior.direction in ['up','down','flat']
    hint: GET /pods/analytics/cost (no params)
  - type: api
    outcome: GET /pods/analytics/cost?days=7 → 200 with body.sparkline length === 7
    hint: GET /pods/analytics/cost?days=7
  - type: api
    outcome: GET /pods/analytics/cost?days=0 → 400 with body.error and body.code === 'invalid_days'
    hint: GET /pods/analytics/cost?days=0
  - type: api
    outcome: GET /pods/analytics/cost?days=-5 → 400 with body.error
    hint: GET /pods/analytics/cost?days=-5
  - type: api
    outcome: GET /pods/analytics/cost?days=abc → 400 with body.error
    hint: GET /pods/analytics/cost?days=abc
touches:
  - packages/shared/src/types/analytics.ts
  - packages/shared/src/index.ts
  - packages/daemon/src/pods/cost-aggregation.ts
  - packages/daemon/src/pods/cost-aggregation.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/integration.test.ts
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-repository.ts
  - packages/desktop/
  - packages/shared/src/types/pod.ts
  - packages/shared/src/pricing/
---

## Task

Build the cost analytics endpoint and the aggregation logic that
backs it. Read-only — no writes, no migrations. Reads
`phaseTokenUsage` (extended in Brief 02) and applies pricing
(Brief 01) at aggregation time.

### `CostAnalyticsResponse` type (shared)

Create `packages/shared/src/types/analytics.ts` with the contract from
`design.md` → Contracts → Cost analytics response. Re-export from
`packages/shared/src/index.ts`.

### Aggregation module

`packages/daemon/src/pods/cost-aggregation.ts` exports:

```ts
export interface CostAggregationDeps {
  podRepo: PodRepository;
  now?: () => Date;  // injectable for tests; defaults to () => new Date()
}

export interface CostAggregationOptions {
  days: number;
}

export function aggregateCost(
  deps: CostAggregationDeps,
  options: CostAggregationOptions,
): CostAnalyticsResponse;
```

Internals (pure, synchronous; the existing repository already gives us
all rows synchronously via `better-sqlite3`):

1. **Window math.** `now = deps.now()` (default `new Date()`).
   `windowEnd = now`. `windowStart = now - days × 86400000ms`.
   `priorEnd = windowStart`. `priorStart = priorEnd - days ×
   86400000ms`. ISO strings for both windows.

2. **Fetch.** `podRepo.list({ ... })` returning all worker pods
   (`isWorkspace: false`) in terminal states (`['complete', 'killed',
   'failed', 'rejected']`) within `[priorStart, windowEnd]`. If the
   existing `list()` filter doesn't support a date range, do a
   broader fetch and filter in-memory — operator-grade scale; the pod
   table is small. Don't add a new repository method just for this;
   inline the filter.

3. **Bucket pods into current vs prior** by `pod.completedAt`.

4. **Effective cost per pod.** `effectiveCostUsd(pod)` from the
   pricing module (Brief 01).

5. **Sparkline.** Initialize an array of length `days`, indexed by day
   offset from `windowStart`. For each current-window pod, increment
   the day bucket by its effective cost. Return as
   `[{ day: 'YYYY-MM-DD', costUsd: number }, ...]` in chronological
   order. Days with no pods stay at 0 (don't omit them).

6. **Total + deltaVsPrior.** Total = sum of current-window effective
   costs. Prior total = sum of prior-window effective costs. Direction:
   `up` if current > prior × 1.05, `down` if current < prior × 0.95,
   `flat` otherwise. Value: `current - prior` (signed dollars).

7. **byPhase.** Stacked bar segments. For each current-window pod,
   walk its `phaseTokenUsage`:
   - `agent_initial`, `agent_rework_<N>`, `review`, `plan_eval`:
     compute `computeCost(pod.model, bucket.input, bucket.output)`
     and sum into the matching segment.
   - For pods missing `phaseTokenUsage` entirely, OR pods where
     `effectiveCostUsd(pod) > sum(bucket costs)`, attribute the
     remainder to a synthetic `agent_legacy` segment. This handles
     both pre-Phase-1 pods (no buckets at all) and the gap between
     `pod.costUsd` (vendor-reported total) and the sum of
     phase-attributed cost (vendor-reported total can be slightly
     higher because it includes cache reads, etc.).
   - Output ordering: `agent_initial` → `agent_rework_1` →
     `agent_rework_2` → ... (sorted numerically) → `review` →
     `plan_eval` → `agent_legacy`. Skip segments with `costUsd === 0`.

8. **byProfileModel.** Group current-window pods by
   `(profile, model)`. Sum effective cost; count pods. Sort by cost
   desc.

9. **top10.** Sort current-window pods by effective cost desc; take
   first 10. Map to the response shape (podId, profile, model,
   finalStatus, costUsd, completedAt).

10. **waste.** Filter current-window pods to status ∈ `['killed',
    'failed', 'rejected']`. Sum effective cost; count.

Pricing helpers come from `@autopod/shared` per Brief 01.

### Endpoint

Register in `packages/daemon/src/api/routes/pods.ts`:

```ts
app.get('/pods/analytics/cost', async (request, reply) => {
  const days = parseDays(request.query);
  if (days === null) {
    reply.status(400);
    return { error: 'days must be a positive integer', code: 'invalid_days' };
  }
  return aggregateCost({ podRepo }, { days });
});
```

`parseDays` accepts:
- missing `days` → returns `30` (default)
- valid positive integer → returns it
- zero, negative, non-integer, non-numeric → returns `null` (signals 400)

Place the route registration adjacent to the other analytics-style
routes (`/pods/quality/trends`, `/pods/scores`) for grep-ability.

### Tests

`cost-aggregation.test.ts` is the meat. Use `createTestDb()`,
`insertTestProfile()`, and a small helper to insert terminal pods
with controlled `completedAt`, `model`, `costUsd`, `inputTokens`,
`outputTokens`, `phaseTokenUsage` shapes.

`integration.test.ts` covers the HTTP wiring + 400 paths.

## Touches

- `packages/shared/src/types/analytics.ts` (new)
- `packages/shared/src/index.ts` (re-export line)
- `packages/daemon/src/pods/cost-aggregation.ts` (new)
- `packages/daemon/src/pods/cost-aggregation.test.ts` (new)
- `packages/daemon/src/api/routes/pods.ts` (new route only)
- `packages/daemon/src/integration.test.ts` (new test cases)

## Does not touch

- `pod-manager.ts` and `pod-repository.ts` — Brief 02 owns those.
- `packages/desktop/` — Brief 04.
- `packages/shared/src/pricing/` — Brief 01 owns the pricing module;
  Brief 03 imports from it.
- `packages/shared/src/types/pod.ts` — Brief 02 owns the
  `phaseTokenUsage` shape.

## Constraints

From `design.md` → Contracts → Cost analytics response: the response
shape is fixed. Don't add fields. Don't omit fields.

From `design.md` → Contracts → endpoint: the only query param is
`days`. No `from`, no `to`, no `profile=`, no `model=`. Filtering
narrower than the trailing window is deferred (see `purpose.md` →
Non-goals).

From `purpose.md` → Glossary → Effective cost: prefer `pod.costUsd`
when > 0; otherwise compute from tokens × pricing. Implemented as
`effectiveCostUsd()` in the pricing module — do NOT re-implement it
here.

From ADR-016 → Consequences: `agent_rework_<N>` keys are open-ended.
Sort numerically (parse the suffix). Ignore unrecognized keys with a
single warn log per request — do not throw.

The validation pipeline runs the daemon as `NODE_ENV !==
'production'`, so the auth plugin accepts all tokens. The endpoint is
NOT behind `RequiresUserType` or any role gate, so the `api` ACs in
this brief WILL fire correctly.

## Test expectations

`cost-aggregation.test.ts`:

- **Empty DB** → `{ total: 0, sparkline: array of 30 zeros,
  deltaVsPrior: { value: 0, direction: 'flat' }, byPhase: [],
  byProfileModel: [], top10: [], waste: { total: 0, podCount: 0 } }`.
- **Sparkline length matches days param** for `days = 1`, `7`, `30`,
  `365`.
- **Window boundaries.** A pod with `completedAt` exactly at
  `windowStart` is INCLUDED; a pod at `windowStart - 1ms` is in the
  prior window. Pin the boundary explicitly.
- **Effective cost — Claude path.** Pod with `costUsd: 5.00`,
  `model: 'claude-opus-4-7'`, large token counts → effective cost is
  `5.00` (uses recorded value, ignores tokens).
- **Effective cost — computed path.** Pod with `costUsd: 0`,
  `model: 'gpt-5'`, `inputTokens: 1_000_000`, `outputTokens: 0` →
  effective cost is `1.25`.
- **Effective cost — unknown model.** Pod with `costUsd: 0`,
  `model: 'unknown-foo'` → effective cost is `0` (warn log expected).
- **byPhase ordering.** Pod with buckets `agent_rework_2`,
  `agent_initial`, `agent_rework_1`, `review` → output order is
  `agent_initial`, `agent_rework_1`, `agent_rework_2`, `review`.
- **agent_legacy reconstruction.** Pre-Phase-1 pod with `costUsd:
  10.00` and no `phaseTokenUsage` → byPhase contains a single
  `agent_legacy` segment with `costUsd: 10.00`.
- **agent_legacy gap handling.** Phase-1 pod with `costUsd: 10.00`
  and phase buckets summing to `7.00` of computed cost →
  `agent_legacy` contains the `3.00` gap.
- **Skip zero-cost segments.** A pod with `phaseTokenUsage.review = {
  inputTokens: 0, outputTokens: 0 }` does not contribute a `review`
  segment (no zero rows).
- **Waste filter.** Pods with status `killed`, `failed`, `rejected`
  contribute to waste; `complete` pods do not. `force_completed`
  pods do not (per `purpose.md` glossary).
- **Top-10 ordering and limit.** 15 pods inserted with varying costs
  → top10 length is exactly 10, sorted by cost desc.
- **Workspace pod exclusion.** A workspace pod (`isWorkspace: true`)
  in the window contributes nothing to any section.
- **Non-terminal pod exclusion.** A `running` pod in the window
  contributes nothing.
- **deltaVsPrior thresholds.** Prior $100, current $110 → `up`,
  value `+10`. Prior $100, current $93 → `down`, value `-7`. Prior
  $100, current $103 → `flat`, value `+3`. Prior $0, current $0 →
  `flat`, value `0`. Prior $0, current $50 → `up` (zero-prior is
  treated as up if current > 0).

`integration.test.ts`:

- **Default days.** `app.inject({ method: 'GET', url:
  '/pods/analytics/cost' })` → 200, `body.sparkline.length === 30`.
- **Custom days.** `?days=7` → 200, `body.sparkline.length === 7`.
- **Invalid days.** `?days=0`, `?days=-1`, `?days=abc`, `?days=1.5` →
  400 with `code: 'invalid_days'`.
- **Empty DB shape.** Confirm the response has all keys even with
  no pods.

## Risks / pitfalls

- **Repository fetch shape.** `podRepo.list()` may not have a
  date-range filter; if it doesn't, do an in-memory filter. Don't add
  a new public method to the repository for one consumer. The pod
  table is operator-grade size (thousands at most) — performance is
  not the constraint.
- **`pod.completedAt` may be null** for non-terminal pods (filtered
  out anyway), but a sanity-check assertion at the top of aggregation
  will catch any shape surprise.
- **Floating-point summation drift.** Summing many small `computeCost`
  results can accumulate sub-cent error. That's fine for display.
  Don't try to round per-pod; round only at format time in Brief 04.
- **Day-boundary ambiguity.** Sparkline buckets days using the
  daemon's local timezone (whatever `new Date()` reports). For
  Esben (single user), this is fine. Don't try to be timezone-aware;
  the dashboard is for one operator.
- **Top-10 fix-pod blast.** A fix pod with high `costUsd` shows up
  as its own row, separate from the parent. `purpose.md` calls this
  out explicitly as a non-goal — don't try to roll up.
- **Schema validation library.** Fastify uses Zod or schema validators
  in some routes; check whether the existing pod routes use a query
  schema. If they do, follow the convention; if they hand-parse,
  hand-parse. Either way, the 400 path must produce
  `{ error, code }` to satisfy the AC.

## Wrap-up

1. Run `/simplify` and address findings.
2. `npx pnpm build` — must pass.
3. `npx pnpm --filter @autopod/daemon test` — must pass.
4. `./scripts/validate.sh` — must pass (this is what the validation
   pipeline runs; the new `api` ACs fire against the running
   container).
5. Commit and push.
