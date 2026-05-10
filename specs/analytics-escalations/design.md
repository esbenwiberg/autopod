# Design — Analytics Escalations

## Blast radius

### Daemon (Brief 01)
- `packages/daemon/src/pods/escalations-aggregator.ts` (new) — pure
  aggregation function from raw query rows to
  `EscalationsAnalyticsResponse`. Co-located with Phase 2's
  `reliability-aggregator.ts` and Phase 5a's
  `throughput-aggregator.ts` (same data domain: pods + events +
  escalations).
- `packages/daemon/src/pods/escalations-aggregator.test.ts` (new) —
  unit tests for cohort selection, rate math (with empty cohort,
  100% case, mixed types), TTR bucketing (boundary values, open-row
  exclusion), per-profile sort + small-N fold-in, blocker pattern
  grouping + pod-id cap, prior-window delta.
- `packages/daemon/src/api/routes/pods.ts` (modify) — register
  `GET /pods/analytics/escalations`. Mirror the Reliability /
  Throughput route registration pattern at `pods.ts:244-256`; do not
  refactor adjacent routes.
- `packages/daemon/src/api/routes/pods.test.ts` (modify) — extend
  with route-level integration tests modelled on the Reliability
  block.
- `packages/daemon/src/index.ts` (modify) — wire the new aggregator
  into the route registration, alongside the existing reliability /
  quality / cost / safety / throughput wiring.

### Shared types (Brief 01)
- `packages/shared/src/types/analytics.ts` (modify) — add
  `EscalationsAnalyticsResponse`, `EscalationsSummary`,
  `AskHumanTtr`, `AskHumanTtrBucket`, `PerProfileEscalation`,
  `BlockerPattern`, `HumanAttentionKind`.
- `packages/shared/src/index.ts` (modify) — re-export the new types.

### Desktop (Brief 02)
- `packages/desktop/Sources/AutopodClient/Types/EscalationsAnalyticsResponse.swift`
  (new) — Codable mirror of the TS contract.
- `packages/desktop/Tests/AutopodClientTests/EscalationsAnalyticsResponseTests.swift`
  (new) — JSON-decode coverage modelled on
  `ReliabilityAnalyticsResponseTests.swift` and
  `SafetyAnalyticsResponseTests.swift`.
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` (modify) —
  add `getEscalationsAnalytics(days:)` next to
  `getReliabilityAnalytics`/`getQualityAnalytics`/`getSafetyAnalytics`
  /`getThroughputAnalytics`.
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift`
  (modify) — extend the enum with `.escalations`. Existing exhaustive
  switches will fail to compile until they handle the new case — do
  that in the same brief.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`
  (modify) — add `.escalations` switch case routing to the new drill
  view.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift`
  (modify) — Escalations card data wiring (value =
  `"\(Int(round(summary.selfRecoveryRate * 100)))%"`,
  sparkline = `summary.dailyHumanCountSparkline.map(\.count)`,
  delta = `summary.selfRecoveryRateDelta`, sub-line per UX-flows
  section).
- `packages/desktop/Sources/AutopodUI/Views/Analytics/EscalationsDrillView.swift`
  (new) — three-section drill with days picker; structure mirrors
  `ThroughputDrillView` and `SafetyDrillView`.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift`
  (modify) — pass `loadEscalationsAnalytics` closure into the
  existing `AnalyticsView(...)` call site.

## Seams

Two briefs, one pod boundary.

1. **Daemon endpoint (Brief 01)** — owns the aggregator, the route,
   and the TS contract. Foundation for Brief 02.
2. **Desktop card + drill (Brief 02)** — consumes the contract from
   Brief 01 verbatim. Hard sequential dependency.

Brief order:
- 01 ships first (sequential).
- 02 must follow 01 (contract dependency).

### Coordination with analytics-throughput (Phase 5a)

Phase 5a's Brief 02 also extends `AnalyticsCardKind` (with
`.throughput`) and edits the same exhaustive-switch sites. **Merge
analytics-throughput Brief 02 before starting analytics-escalations
Brief 02** to avoid a 3-way conflict on `AnalyticsCardKind.swift`,
`AnalyticsRightPaneView.swift`, `AnalyticsView.swift`, and
`MainView.swift`. The two desktop briefs are independent in scope but
collide on those files. Brief 01 of each spec is fully independent
(different aggregator file, different route, different shared types
section).

## Contracts

`EscalationsAnalyticsResponse` is the only cross-pod contract on the
wire. Brief 01 owns the TS source; Brief 02 mirrors in Swift.

```ts
// packages/shared/src/types/analytics.ts (added in Brief 01)

/** Escalation types that require a human to look at and respond.
 *  ask_ai (agent-consults-another-AI) and request_credential (JIT
 *  vending) are explicitly excluded — they're autonomous-recovery
 *  signal, not stuck-ness signal. */
export type HumanAttentionKind =
  | 'ask_human'
  | 'report_blocker'
  | 'validation_override'
  | 'action_approval';

export interface EscalationsSummary {
  /** Fraction in [0, 1]. Returns 1.0 when cohortSize === 0
   *  (no pods → nothing to recover from). UI may suppress delta in
   *  that case. */
  selfRecoveryRate: number;

  /** Size of the terminal cohort over the trailing window. Denominator
   *  for selfRecoveryRate and per-profile rates. */
  cohortSize: number;

  /** Distinct pod count in the terminal cohort with at least one
   *  human-attention escalation. Numerator for
   *  (cohortSize - humanAttentionPodCount) / cohortSize. */
  humanAttentionPodCount: number;

  /** Total escalation rows of human-attention type whose pod is in
   *  the terminal cohort. Used by the card sub-line and as the
   *  sparkline grand total. May exceed humanAttentionPodCount when
   *  one pod escalates multiple times. */
  humanAttentionCount: number;

  /** Total ask_ai escalation rows whose pod is in the terminal
   *  cohort. Reported in the card sub-line for context, never in
   *  the rate. */
  askAiCount: number;

  /** One entry per day in window (length === days). count = number
   *  of human-attention escalation rows whose escalations.created_at
   *  falls in that local-UTC day. Days with zero escalations emit
   *  count = 0. */
  dailyHumanCountSparkline: Array<{ day: string; count: number }>;

  /** Direction: 'up' when value > 0.005 (i.e. 0.5pp), 'down' when
   *  < -0.005, 'flat' otherwise. value = signed difference in
   *  selfRecoveryRate vs the immediately-prior window of the same
   *  length, in absolute fraction (so a swing from 80% → 85% gives
   *  value = 0.05, direction 'up' — note 'up' on rate is good).
   *  Returns { value: 0, direction: 'flat' } when cohortSize === 0
   *  in either window. */
  selfRecoveryRateDelta: {
    value: number;
    direction: 'up' | 'down' | 'flat';
  };
}

export interface AskHumanTtrBucket {
  /** Display label for the bucket, exact-string from the locked set:
   *  '<1m', '1–5m', '5–15m', '15m–1h', '1–4h', '4–12h', '12–24h',
   *  '>24h'. Always 8 buckets in this fixed order. */
  label: string;
  /** Count of resolved ask_human escalations whose
   *  (resolved_at - created_at) falls in this bucket. */
  count: number;
}

export interface AskHumanTtr {
  /** Always 8 entries in the fixed label order above. Empty cohort
   *  emits all-zero counts. */
  buckets: AskHumanTtrBucket[];

  /** Count of resolved ask_human escalations created in window
   *  (= sum of buckets[].count). */
  resolvedCount: number;

  /** Count of unresolved ask_human escalations created in window,
   *  point-in-time at request time. Reported in the section header
   *  ("X resolved · Y open"); excluded from the histogram. */
  openCount: number;

  /** Largest (resolved_at - created_at) seconds across the resolved
   *  cohort. Reported as a "max: Xh Ym" caption in the section
   *  footer. Returns 0 when resolvedCount === 0. */
  maxSeconds: number;
}

export interface PerProfileEscalation {
  /** Profile name verbatim from pods.profile_name. May be the
   *  synthetic '<small profiles>' bucket when fold-in applies. */
  profile: string;

  /** Distinct pod count for this profile in the terminal cohort. */
  podCount: number;

  /** Distinct pod count for this profile with ≥1 human-attention
   *  escalation. */
  escalatedCount: number;

  /** = escalatedCount / podCount. In [0, 1]. */
  rate: number;
}

export interface BlockerPattern {
  /** Verbatim from escalations.payload->>'description'. Whitespace
   *  is trimmed; otherwise no normalisation (case-sensitive,
   *  punctuation-sensitive). Empty/null descriptions are excluded
   *  from the grouping. */
  description: string;

  /** Total report_blocker escalation rows with this exact
   *  description over the window (no terminal-cohort restriction —
   *  any report_blocker in window counts). */
  count: number;

  /** Up to 10 distinct pod IDs that hit this blocker, ordered
   *  most-recent-first by escalations.created_at. May be shorter
   *  than count when count > 10 (UI shows '+ N more'). */
  podIds: string[];
}

export interface EscalationsAnalyticsResponse {
  summary: EscalationsSummary;
  askHumanTtr: AskHumanTtr;
  /** Sorted by rate DESC, ties broken by podCount DESC. May
   *  include the synthetic '<small profiles>' row at any position
   *  per the sort. */
  perProfile: PerProfileEscalation[];
  /** Top 10 by count, sorted DESC. Ties broken by description
   *  alphabetically. Length <= 10. */
  blockerPatterns: BlockerPattern[];
}
```

### Validation rules (mirror Reliability/Throughput/Quality/Safety)
- `days` defaults to `30`.
- `days < 1` → `400 { error: 'days must be a positive integer', code: 'invalid_days' }`.
- `days > 365` → `400` with the same code.

### Cohort discipline (NON-NEGOTIABLE)

Three cohorts in one endpoint — easy to mix up. Name them distinctly
in the aggregator and consume them only where they belong:

| Section                     | Cohort                                  | Notes |
|-----------------------------|-----------------------------------------|-------|
| `summary.selfRecoveryRate` denominator | terminal cohort               | reuse `buildTerminalCohortClause(days)` |
| `summary.humanAttentionPodCount` / `humanAttentionCount` / `askAiCount` | escalations whose `pod_id` ∈ terminal cohort | inner-join on cohort |
| `summary.dailyHumanCountSparkline` | escalations of human-attention type whose `created_at IN window`, **regardless of pod cohort** | bucketed by `escalations.created_at` UTC daily |
| `askHumanTtr.buckets[]`     | `escalations` rows: `type='ask_human' AND created_at IN window AND resolved_at IS NOT NULL` | pod cohort irrelevant — running pods count |
| `askHumanTtr.openCount`     | same window predicate but `resolved_at IS NULL` at request time | point-in-time |
| `perProfile`                | terminal cohort                         | group by `pods.profile_name`; small-N fold-in |
| `blockerPatterns`           | `escalations` rows: `type='report_blocker' AND created_at IN window` | pod cohort irrelevant |

The two non-cohort sections (`askHumanTtr`, `blockerPatterns`,
`dailyHumanCountSparkline`) are scoped by escalation `created_at`, not
pod `completed_at` — that's the deliberate split. The card's headline
self-recovery rate is cohort-pinned, but the histogram and pattern
table aren't (they answer "how slow am I, what am I being asked
about?", not "how does the cohort behave?").

Reuse `buildTerminalCohortClause(days)` from prior phases (extracted
during analytics-reliability-funnel; check if the helper exists at
`packages/daemon/src/pods/reliability-aggregator.ts` or a shared
`analytics-helpers.ts`. If it's still inlined per-aggregator, inline
the predicate identically here and add a
`// keep in sync with: ...` comment).

### Self-recovery rate derivation

```sql
-- terminal cohort, see buildTerminalCohortClause
WITH cohort AS (...),

-- pods with at least one human-attention escalation
escalated_pods AS (
  SELECT DISTINCT e.pod_id
  FROM escalations e
  WHERE e.pod_id IN (SELECT pod_id FROM cohort)
    AND e.type IN ('ask_human','report_blocker',
                   'validation_override','action_approval')
)

SELECT
  (SELECT COUNT(*) FROM cohort) AS cohort_size,
  (SELECT COUNT(*) FROM escalated_pods) AS escalated_count
```

`selfRecoveryRate = (cohort_size - escalated_count) / cohort_size`
when `cohort_size > 0`, else `1.0` (defined as fully self-recovering
when there are no pods).

### TTR bucketing

For each row in the resolved cohort, compute
`secs = (julianday(resolved_at) - julianday(created_at)) * 86400.0`,
then bucket using right-exclusive boundaries
`[60, 300, 900, 3600, 14400, 43200, 86400]` mapped to the 8 fixed
labels. Implement bucketing in JS over the fetched seconds array
(SQLite case-when is also fine; pick whichever reads cleaner — the
JS path mirrors `throughput-aggregator.ts` time-in-status percentile
math). The `>24h` bucket has no upper bound. Edge case: zero seconds
(somehow resolved instantly) lands in `<1m`.

### Per-profile fold-in

Group escalation pods by `pods.profile_name`. For each group, count
distinct cohort pods (`podCount`) and distinct escalated pods
(`escalatedCount`). Profiles where `podCount < 5` are folded into a
synthetic row with `profile = '<small profiles>'`, `podCount = sum
of folded podCounts`, `escalatedCount = sum of folded escalatedCounts`,
`rate = escalatedCount / podCount`. The synthetic row is suppressed
when no profile folds in (i.e. every profile has `podCount >= 5`).
Sort the result by `rate DESC`, ties broken by `podCount DESC`.

### Blocker patterns derivation

```sql
SELECT
  trim(json_extract(payload, '$.description')) AS description,
  COUNT(*) AS count
FROM escalations
WHERE type = 'report_blocker'
  AND created_at >= datetime('now', '-' || ? || ' days')
  AND json_extract(payload, '$.description') IS NOT NULL
  AND length(trim(json_extract(payload, '$.description'))) > 0
GROUP BY description
ORDER BY count DESC, description ASC
LIMIT 10
```

For each pattern, fetch up to 10 distinct pod IDs:

```sql
SELECT DISTINCT pod_id
FROM escalations
WHERE type = 'report_blocker'
  AND trim(json_extract(payload, '$.description')) = ?
  AND created_at >= datetime('now', '-' || ? || ' days')
ORDER BY created_at DESC
LIMIT 10
```

Description grouping is **case-sensitive, exact-string**. No fuzzy
matching, no lemmatisation, no Levenshtein. Operator-grade triage; if
two descriptions differ by a comma, they're different patterns. The
`payload->>'description'` field is `report_blocker`'s required
property per `packages/shared/src/types/escalation.ts`.

## UX flows

### Sidebar
The locked Phase 0 contract — single `Analytics` row plus disabled
sub-rows. This phase does *not* enable a sub-row (no per-section sub
route; the card grid is the only entry point). If an `Escalations`
sub-row exists in the sidebar from Phase 0, leave it disabled.

### Overview — Escalations card
Same `AnalyticsCard` API as the others (`AnalyticsView.swift:84-96`):

- **value:** `"\(Int(round(summary.selfRecoveryRate * 100)))%"`.
  When `summary.cohortSize == 0`: value = `"—"` (no rate to compute).
- **sparkline:** `summary.dailyHumanCountSparkline.map(\.count)`.
  Empty cohort → nil sparkline.
- **delta:** `AnalyticsCardDelta` formatted as
  `String(format: "%+.0fpp", summary.selfRecoveryRateDelta.value * 100)`,
  direction mapped from `summary.selfRecoveryRateDelta.direction`.
  Empty current cohort or empty prior cohort → nil. Note: 'up' on
  this rate is **good** (more autonomy); the card up/down direction
  arrow should NOT be re-coloured for this — keep the standard
  green-up convention. Operator interprets the rate semantically;
  the chrome stays consistent.
- **sub-line under value:** `"N human · M ai"` where
  - `N` is `summary.humanAttentionCount` (total rows, not pod count).
  - `M` is `summary.askAiCount`.
  - Middle dot is U+00B7. Sub-line suppressed entirely when both N
    and M are 0.
- **isSelected / onClick:** unchanged from the existing pattern.

### Drill view — `EscalationsDrillView`

Header (sticky inside the right-pane scroll):
- **Days picker:** numeric stepper or menu; default 30; values
  `7 / 14 / 30 / 60 / 90`. Re-fetches
  `/pods/analytics/escalations?days=N`.

Body, in scroll order:

1. **`ask_human` time-to-respond histogram** — bar chart with 8
   bars in the locked label order
   `<1m, 1–5m, 5–15m, 15m–1h, 1–4h, 4–12h, 12–24h, >24h`. Bar height
   = `bucket.count`. Cell label shows the count above each bar.
   **Section header:** `"X resolved · Y open"` where X is
   `askHumanTtr.resolvedCount` and Y is `askHumanTtr.openCount`.
   **Section footer:** `"max: Xh Ym"` formatted from
   `askHumanTtr.maxSeconds`, suppressed when `maxSeconds == 0`.
   Empty state: `"No ask_human escalations resolved in last N
   days."` (shown when `resolvedCount == 0`; the open-count and
   footer still render above the empty state). Histogram is
   stats-only — no row click, no expansion.

2. **Per-profile escalation table** — three columns:
   profile · pods · escalated · rate. Sort: rate DESC, ties by
   podCount DESC (server-supplied ordering). Display `rate` as
   `"\(Int(round(rate * 100)))%"`. The synthetic `<small profiles>`
   row, when present, renders with a smaller-text caption "n
   profiles below 5 pods" beneath the row label. Empty state:
   `"No terminal pods in last N days."`. Stats-only — no row click,
   no expansion.

3. **Blocker pattern table** — two columns: description · count.
   Each row is a `DisclosureGroup`. Expanding shows the up-to-10
   `podIds[]` as a vertical list of pod-id chips, plus a
   `+ N more` indicator when `count > podIds.length`. Each pod-id
   chip is clickable → fires `onSelectPod(podId)` (same plumbing
   as the throughput drill's heatmap row click). Empty state:
   `"No report_blocker escalations in last N days."`.

States across all sections:
- **Loading:** `ProgressView` per-section skeleton.
- **Empty:** per-section empty copy as above.
- **Error:** red caption banner above sections — same pattern as
  `ReliabilityDrillView` and `ThroughputDrillView`.

### Row-click navigation

The blocker pattern's pod-id chip click reuses
`analyticsSelectPodResult(sessionId:)` at `MainView.swift:344-373`
(clears the selected card, switches sidebar to All Pods, opens the
detail panel). Set `requestedDetailTab = .summary` so the pod opens
with Summary focused — matching Phase 3 / Phase 5a precedent. There
is no Escalations-specific tab in the pod detail panel and this phase
does not add one.

## Reference reading

- `docs/analytics-dashboard-plan.md` Phase 5 — the seed; this spec
  refines the Escalations half. Throughput is split out to
  `analytics-throughput`.
- `specs/analytics-shell/design.md` — `AnalyticsCard` API + right-pane
  scene state contract (consume as-is, do not widen).
- `specs/analytics-cost/design.md` — trailing-window + composite-endpoint
  conventions; respect verbatim.
- `specs/analytics-reliability-funnel/design.md` — terminal cohort
  definition (lines 171-185), aggregator placement, prior-window
  delta pattern, four-section drill layout, `analyticsSelectPodResult`
  navigation precedent.
- `specs/analytics-quality/design.md` — days picker UX, table row-click
  + Summary tab focus, sticky header in drill.
- `specs/analytics-safety/design.md` — recent multi-section drill
  pattern with empty states; cohort-distinguishing convention.
- `specs/analytics-throughput/design.md` — Phase 5a sibling. Locks the
  one-section-expandable convention (heatmap there; blocker patterns
  here). Owns the parallel `AnalyticsCardKind` extension that this
  spec coordinates against.
- `packages/shared/src/types/escalation.ts` — `EscalationType` union
  (6 values), `AskHumanPayload` / `AskAiPayload` /
  `ReportBlockerPayload` / `ActionApprovalPayload` /
  `ValidationOverridePayload` / `RequestCredentialPayload` shapes.
  Confirms `description` is `report_blocker`'s required field.
- `packages/daemon/src/pods/escalation-repository.ts` — escalation
  CRUD; key invariant: `update()` always sets `resolved_at` when a
  response arrives (line 59), so `resolved_at - created_at` is the
  reliable TTR for resolved rows.
- `packages/daemon/src/db/migrations/001_initial.sql` — escalations
  table schema. Key columns: `id`, `pod_id` (renamed from session_id
  in migration 046), `type`, `payload TEXT`, `response TEXT`,
  `created_at`, `resolved_at`.
- `packages/daemon/src/pods/reliability-aggregator.ts:240-310` —
  prior-window delta math, terminal-cohort sub-query pattern,
  `SQLITE_MAX_VARIABLE_NUMBER` workaround. Brief 01 mirrors these
  patterns.
- `packages/daemon/src/pods/reliability-aggregator.test.ts` — testing
  patterns for cohort fixtures + window math.
- `packages/daemon/src/api/routes/pods.ts:244-256` — Reliability route
  registration pattern; copy the validation envelope and error shape
  for the new `/pods/analytics/escalations` route.
- `packages/daemon/src/api/routes/pods.test.ts:119-360` — Reliability
  route test pattern (days validation, default behaviour, structural
  assertions); template for escalations-route tests.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/QualityDrillView.swift`
  (Phase 3) — days picker + sectioned scroll + table row click.
  Drill layout pattern.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ReliabilityDrillView.swift`
  — error-banner + per-section loading pattern.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/SafetyDrillView.swift`
  — most-recent multi-section drill; empty-state copy idiom.
- `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift:1048` —
  `DetailTab` enum; `.summary` is the row-click focus target.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:344-373` —
  existing `requestedDetailTab` plumbing + `analyticsSelectPodResult`.
- `packages/desktop/Tests/AutopodClientTests/ReliabilityAnalyticsResponseTests.swift`
  — JSON-decode test scaffolding for the Codable mirror.
- `CLAUDE.md` "CRITICAL — migration numbering" — N/A this phase (no
  migration), but kept in mind: highest existing prefix is `097`.
- 📋 ADR-015 (model pricing as bundled JSON) — analytics-relevant
  baseline.
- 📋 ADR-016 (per-attempt phase token taxonomy) — forward-only data
  convention precedent; escalations table has existed since
  migration 001 so the convention is mostly moot here, but the
  pattern is the same: cohort-pin, don't backfill.

## Decisions

No new ADRs introduced by this phase. Every load-bearing choice is
mechanical from existing data + Phase 0/1/2/5a conventions:

- Terminal cohort: identical to Phase 1/2/5a; ADR-equivalent decision
  is "Phase 1 set this; later phases honour it."
- Headline = self-recovery rate (% of terminal pods with NO
  human-attention escalation), not "raw escalation count" or
  "escalations per pod". Rationale: the user picked it explicitly
  ("self-recovery rate %"); operator-grade phrasing aligns with the
  master plan's autonomy framing.
- Human-attention scope: `ask_human + report_blocker +
  validation_override + action_approval`. Excludes `ask_ai` (agent
  consults another AI — autonomous) and `request_credential` (JIT
  vending — routine, not stuck-ness).
- Histogram scope: `ask_human` only. Master plan literal phrasing
  ("ask_human time-to-respond histogram"); other types feed counts
  but not bucketed TTRs.
- Open `ask_human` handling: histogram counts resolved only; open
  count exposed via `askHumanTtr.openCount` and shown in the section
  header ("X resolved · Y open"). Avoids the "open rows haven't
  resolved yet so they belong in `>24h` bucket" trap, which would
  silently inflate the slowest bucket as the window ages.
- TTR bucket boundaries: 60, 300, 900, 3600, 14400, 43200, 86400
  seconds; right-exclusive. Log-scale across operator-relevant
  ranges.
- Per-profile small-N fold-in at `podCount < 5`. Avoids "100% rate
  on a 1-pod profile" misleading the eye. Synthetic
  `<small profiles>` bucket; suppressed when nothing folds in.
- Blocker description grouping: exact-string, case-sensitive, after
  trim. No fuzzy matching. Operator-grade triage signal; if two
  descriptions differ by a comma, treat them as separate.
- Drill expansion asymmetry: only the blocker patterns section
  expands to a pod list (mirroring throughput's heatmap-only
  expansion). Histogram and per-profile are stats-only by design.
- One composite endpoint per card (matches Phases 1/2/3/4/5a;
  rejected alternative was per-section endpoints which would have
  multiplied HTTP calls 4× without latency benefit at this data
  volume).
- No new persistence: all data already exists in `pods` and
  `escalations`.
- Delta direction threshold: `up` if `value > 0.005` (0.5pp), `down`
  if `value < -0.005`, else `flat`. Reasonable for fleets where
  rates move in single percentage points; smaller swings register
  as flat.

ADRs reused:
- ADR-015: Model pricing as bundled JSON (analytics-relevant
  baseline).
- ADR-016: Per-attempt phase token taxonomy — forward-only data
  convention.
