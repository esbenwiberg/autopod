# Design — Analytics Cost (Phase 1)

## Blast radius

**Shared (new files):**
- `packages/shared/src/pricing/model-pricing.json` — bundled price
  catalog (ADR-015).
- `packages/shared/src/pricing/index.ts` — `Pricing` type,
  `MODEL_PRICING` const, `computeCost()` and `effectiveCostUsd()`
  helpers.
- `packages/shared/src/types/analytics.ts` — `CostAnalyticsResponse`
  and the per-section sub-types.

**Shared (modified):**
- `packages/shared/src/types/pod.ts` — extend `phaseTokenUsage` type to
  the union from ADR-016.
- `packages/shared/src/index.ts` — re-export new pricing + analytics
  modules.

**Daemon (new files):**
- `packages/daemon/src/pods/cost-aggregation.ts` — pure aggregation
  logic over `pods` rows; consumes pricing helpers; produces
  `CostAnalyticsResponse`.
- `packages/daemon/src/pods/cost-aggregation.test.ts` — unit tests
  with `createTestDb()` fixtures.

**Daemon (modified):**
- `packages/daemon/src/pods/pod-manager.ts` — extend the `complete`
  event handler at lines 4306-4321 to write per-attempt buckets to
  `phaseTokenUsage`.
- `packages/daemon/src/pods/pod-manager.test.ts` — add coverage for
  per-attempt bucket writes across the validation-feedback loop.
- `packages/daemon/src/pods/pod-repository.ts` — extend the
  `phaseTokenUsage` type union at lines 173-175 to match the new
  shape; the JSON.parse / JSON.stringify path is unchanged.
- `packages/daemon/src/api/routes/pods.ts` — register
  `GET /pods/analytics/cost`.
- `packages/daemon/src/integration.test.ts` — add an integration test
  for the new endpoint.

**Desktop (new files):**
- `packages/desktop/Sources/AutopodClient/Types/CostAnalyticsResponse.swift`
  — `Decodable` mirrors of the shared TS types.

**Desktop (modified):**
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` — add
  `getCostAnalytics(days:)` method.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift`
  — Cost card uses real fetched data (sparkline, delta).
  `CostDrillView` (added in Phase 0 as a placeholder) gets its real
  body: four private helper subviews — phase bar, profile×model grid,
  top-10 list, waste callout.

Untouched:
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsSection.swift`
  (Phase 0). Cost section stays disabled in the sidebar.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`
  (Phase 0). The right-pane host already routes
  `.cost → CostDrillView`; only the drill body is filled in.
- All other daemon code.

## Seams

Four briefs, sequential. Each builds on the prior; none can be
parallelized because each later brief reads contracts the earlier
brief produces.

1. **Pricing seam (Brief 01).** New `@autopod/shared` pricing module +
   JSON catalog. Pure additive; no daemon or desktop touch. Output: the
   pricing helpers and types that Briefs 02 and 03 consume.

2. **Instrumentation seam (Brief 02).** Daemon writer-side change in
   `pod-manager.ts` that snapshots per-attempt token deltas, plus the
   `phaseTokenUsage` type extension in `@autopod/shared` and
   `pod-repository.ts`. Output: forward-only data in
   `pods.phase_token_usage` per ADR-016. Pricing module from Brief 01
   is *not* touched here — costing happens at read time.

3. **Endpoint seam (Brief 03).** Cost aggregation module + the
   `GET /pods/analytics/cost` route. Reads pricing (Brief 01), reads
   per-attempt buckets (Brief 02), reconstructs `agent_legacy` for
   pre-instrumentation pods. Output: the composite endpoint the
   desktop will call.

4. **Desktop wiring seam (Brief 04).** Swift `Decodable` types,
   `DaemonAPI.getCostAnalytics()`, and the `CostDrillView` body
   refactor. Output: a working Cost card with all four sub-views in
   the drill.

Sequential ordering is enforced because: Brief 02's writer-side
change depends on Brief 01's type extension (the `agent_rework_<N>`
keys). Brief 03's aggregation depends on Brief 01's pricing helpers
and Brief 02's writer (otherwise the per-attempt sub-view is empty
on test data). Brief 04 depends on Brief 03's response shape.

## Contracts

### Pricing (Brief 01 produces; Briefs 02-04 consume — but only Brief 03 actually reads)

```ts
// packages/shared/src/pricing/index.ts
export interface ModelPrice {
  /** USD per 1 000 000 input tokens. */
  inputPer1M: number;
  /** USD per 1 000 000 output tokens. */
  outputPer1M: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPrice>>;

/** Compute cost from token counts. Returns 0 when model is unknown. */
export function computeCost(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): number;

/**
 * Effective cost for a pod: prefer the runtime-reported costUsd when
 * non-zero (Claude); otherwise compute from tokens × pricing[model].
 */
export function effectiveCostUsd(pod: {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}): number;
```

JSON shape (ADR-015 has the full rationale):

```json
{
  "claude-opus-4-7":   { "inputPer1M": 15.00, "outputPer1M": 75.00 },
  "claude-sonnet-4-6": { "inputPer1M": 3.00,  "outputPer1M": 15.00 },
  "gpt-5":             { "inputPer1M": 1.25,  "outputPer1M": 10.00 }
}
```

### Phase token taxonomy (Brief 02 produces; Brief 03 consumes)

```ts
// packages/shared/src/types/pod.ts (extended)
export type PhaseTokenUsage = Partial<Record<
  | 'agent_initial'
  | `agent_rework_${number}`  // 'agent_rework_1', 'agent_rework_2', ...
  | 'review'
  | 'plan_eval',
  { inputTokens: number; outputTokens: number }
>>;
```

ADR-016 covers the writer placement, the open-ended `agent_rework_<N>`
key family, and the `agent_legacy` reconstruction the aggregator must
do for pre-Phase-1 pods.

### Cost analytics response (Brief 03 produces; Brief 04 consumes)

```ts
// packages/shared/src/types/analytics.ts
export interface CostAnalyticsResponse {
  /** Total effective cost over the trailing window. */
  total: number;
  /** Length always equals `days` from the query. */
  sparkline: Array<{ day: string; costUsd: number }>;
  /** Delta vs the immediately preceding window of the same length. */
  deltaVsPrior: { value: number; direction: 'up' | 'down' | 'flat' };
  /** Stacked bar segments. Order: agent_initial, rework_1..N, review, plan_eval, legacy. */
  byPhase: Array<{ phase: string; costUsd: number }>;
  /** Profile × model breakdown for the matrix view. */
  byProfileModel: Array<{
    profile: string;
    model: string | null;
    costUsd: number;
    podCount: number;
  }>;
  /** Top 10 most expensive pods in the window. */
  top10: Array<{
    podId: string;
    profile: string;
    model: string | null;
    finalStatus: 'complete' | 'killed' | 'failed' | 'rejected';
    costUsd: number;
    completedAt: string;
  }>;
  /** Strict waste — pods with no merge outcome. */
  waste: {
    total: number;
    podCount: number;
  };
}
```

Endpoint (Brief 03 produces; Brief 04 consumes):

```
GET /pods/analytics/cost?days=N
  - days: integer ≥ 1, default 30
  - 200 → CostAnalyticsResponse
  - 400 → { error, code } when days is invalid
```

Filters that are non-negotiable (apply to every section of the
response):
- `pod.isWorkspace == false` (worker pods only)
- `pod.status IN ('complete', 'killed', 'failed', 'rejected')`
- `pod.completedAt` ∈ trailing window

## UX flows

**Card on Overview.** Phase 0 already renders the Cost card with `nil`
sparkline + `nil` delta. Phase 1 wires real data: `AnalyticsView`
fetches `getCostAnalytics(days: 30)` in its `.task`, populates the
card's `value` (formatted total), `sparkline` (the 30-day series), and
`delta` (formatted from `deltaVsPrior`). On fetch error, the card shows
`"—"` for value and hides sparkline/delta — same shape as Phase 0
no-data.

**Drill entry.** User clicks Cost card → Phase 0 toggles
`selectedAnalyticsCard = .cost` → `AnalyticsRightPaneView` routes to
`CostDrillView`. The drill subscribes to the same `getCostAnalytics`
fetch (passed in as a prop, not re-fetched) so card and drill stay
consistent.

**Drill body.** A single `ScrollView` with four sections, in order:
1. Per-phase stacked bar (`Charts.BarMark` with `position:
   .stacking`). High-N rework chains collapse to "+ N more reworks"
   in the legend if N > 5.
2. Profile × model grid. Rows = profiles, columns = models, cells =
   $ + pod count. Horizontally scrollable when many models.
3. Top-10 list. Tappable rows. Each row shows pod ID (short),
   profile, model, status badge, cost. Tap fires `onSelectPod`
   which clears `selectedAnalyticsCard`, switches sidebar to
   `.all`, sets `selectedSessionId` (Phase 0 plumbing).
4. Waste callout. Single styled card: "$X wasted across N pods" with
   a status-tag breakdown (killed: $a, failed: $b, rejected: $c).

**States.** Loading: skeleton placeholders for each section. Empty
(no terminal pods in window): single centered message "No completed
pods in the last N days." Error: inline error banner with retry.

**Disabled section unchanged.** The Cost sub-row in the sidebar
remains `.disabled(true)` per `AnalyticsSection.isShipped`. Phase 1
fills the *card on Overview* and its right-pane drill — it does not
unlock the dedicated Cost section. That's a future phase.

## Reference reading

- `specs/analytics-shell/design.md` — Phase 0 contracts. Phase 1
  consumes `AnalyticsCard`, `AnalyticsCardKind.cost`,
  `AnalyticsRightPaneView`, and `CostDrillView` (placeholder).
- `packages/daemon/src/db/migrations/089_pod_phase_token_usage.sql` —
  the existing column. No new migration needed; new keys are
  additive at the application layer (ADR-016).
- `packages/daemon/src/runtimes/claude-stream-parser.ts:180` — where
  `costUsd` enters the system from the Claude SSE stream. Phase 1
  treats this value as authoritative when present and falls back to
  `computeCost()` only when it's 0.
- `packages/daemon/src/pods/pod-manager.ts:4306-4321` — the
  `complete`-event handler that today accumulates totals. Brief 02
  extends this exact block.
- `packages/daemon/src/pods/quality-score-repository.ts:167` —
  precedent for the trailing-window query pattern (`datetime('now',
  '-' || @days || ' days')`).
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift:37-58`
  — current client-side aggregation. Phase 1 replaces the
  `totalCost` computed property with the fetched `total` for the
  Cost card; the rest of `AnalyticsView` (Quality / Status cards) is
  untouched.
- `packages/daemon/src/integration.test.ts` — the harness that drives
  endpoint integration tests via `app.inject()`. New endpoint test
  goes here.
- `docs/decisions/ADR-015-model-pricing-bundled-json.md` — pricing
  catalog source of truth.
- `docs/decisions/ADR-016-phase-token-per-attempt-taxonomy.md` —
  per-attempt phase taxonomy.
- `CLAUDE.md` "Pod Lifecycle" — the validation-feedback loop the
  per-attempt instrumentation hooks into.
- `packages/daemon/CLAUDE.md` "Database / Migrations" — confirms
  no migration is needed (the column is already TEXT JSON).

## Decisions

- **ADR-015** Model pricing — bundled JSON in `@autopod/shared`,
  manual refresh, no auto-fetch. (Introduced this phase.)
- **ADR-016** Phase token taxonomy — per-attempt agent buckets +
  existing `review` / `plan_eval`; forward-only data; `agent_legacy`
  reconstructed at aggregation time. (Introduced this phase.)
