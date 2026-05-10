---
title: "Add escalations analytics endpoint"
acceptance_criteria:
  - { type: api, test: "GET /pods/analytics/escalations?days=30", pass: "200 with body.summary.selfRecoveryRate (number), body.summary.cohortSize (number), body.summary.humanAttentionPodCount (number), body.summary.humanAttentionCount (number), body.summary.askAiCount (number), body.summary.dailyHumanCountSparkline (array, length 30), body.summary.selfRecoveryRateDelta, body.askHumanTtr.buckets (array, length 8), body.askHumanTtr.resolvedCount (number), body.askHumanTtr.openCount (number), body.askHumanTtr.maxSeconds (number), body.perProfile (array), body.blockerPatterns (array, length <= 10)", fail: "non-200 OR any required key missing OR sparkline length != 30 OR askHumanTtr.buckets length != 8 OR blockerPatterns length > 10" }
  - { type: api, test: "GET /pods/analytics/escalations?days=0", pass: "400 with body.code = 'invalid_days'", fail: "non-400 or wrong code" }
  - { type: api, test: "GET /pods/analytics/escalations?days=400", pass: "400 with body.code = 'invalid_days'", fail: "non-400 or wrong code" }
touches:
  - packages/daemon/src/pods/escalations-aggregator.ts
  - packages/daemon/src/pods/escalations-aggregator.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/index.ts
  - packages/shared/src/types/analytics.ts
  - packages/shared/src/index.ts
does_not_touch:
  - packages/desktop/
  - packages/cli/
  - packages/escalation-mcp/
  - packages/validator/
  - packages/daemon/src/db/migrations/
---

## Task

Add `GET /pods/analytics/escalations?days=N` on the daemon. Pure
read/aggregate path — no schema, no writers, no new persistence.
Returns one composite payload covering the headline self-recovery
rate, the `ask_human` time-to-respond histogram, the per-profile
escalation table, and the top-10 blocker pattern table.

The full endpoint shape lives in `design.md` → Contracts. Implement
exactly that shape; do not widen it; do not invent new fields.

### Brief overview of the work

1. **Shared types** — extend
   `packages/shared/src/types/analytics.ts` with
   `HumanAttentionKind`, `EscalationsSummary`, `AskHumanTtrBucket`,
   `AskHumanTtr`, `PerProfileEscalation`, `BlockerPattern`,
   `EscalationsAnalyticsResponse`. Re-export from
   `packages/shared/src/index.ts`.

2. **Aggregator** — new
   `packages/daemon/src/pods/escalations-aggregator.ts`. Co-located
   with `reliability-aggregator.ts` and
   `throughput-aggregator.ts` (same data domain). Export a
   `computeEscalationsAnalytics(db, days): EscalationsAnalyticsResponse`
   that runs all queries and assembles the response.

   Three cohorts (NON-NEGOTIABLE — see `design.md` → Cohort discipline):
   - **Terminal cohort** (`buildTerminalCohortClause(days)`) — denominator
     for `selfRecoveryRate`, source of `humanAttentionPodCount`,
     `humanAttentionCount`, `askAiCount`, and `perProfile`. Reuse
     the helper from prior analytics phases if it exists; otherwise
     inline the predicate identically and add a
     `// keep in sync with: ...` comment.
   - **Escalation-window cohort** — escalations whose `created_at IN
     window`, regardless of pod cohort. Used by `dailyHumanCountSparkline`,
     `askHumanTtr.buckets[]`, `askHumanTtr.resolvedCount`,
     `askHumanTtr.openCount` (open is point-in-time), and
     `blockerPatterns`.
   - **`askHumanTtr` resolved** — `escalations` rows with
     `type='ask_human' AND created_at IN window AND resolved_at IS NOT NULL`.
     `askHumanTtr.openCount` is the same window predicate but
     `resolved_at IS NULL`.

   Helper math (full SQL examples in `design.md`):
   - `summary.selfRecoveryRate` —
     `(cohortSize - humanAttentionPodCount) / cohortSize`. When
     `cohortSize === 0`, return `1.0` (defined as fully
     self-recovering with no pods).
   - `summary.humanAttentionPodCount` — `COUNT(DISTINCT e.pod_id)`
     where `e.type IN ('ask_human','report_blocker','validation_override','action_approval')`
     AND `e.pod_id IN cohort`.
   - `summary.humanAttentionCount` — total escalation rows of those
     types whose pod is in cohort. May exceed
     `humanAttentionPodCount`.
   - `summary.askAiCount` — same shape, `type='ask_ai'`.
   - `summary.dailyHumanCountSparkline` — group human-attention
     escalations (regardless of pod cohort) by
     `date(escalations.created_at)` UTC; pad missing days with
     `count: 0`; length === days.
   - `summary.selfRecoveryRateDelta` — prior window of identical
     length (mirror Reliability's pattern at
     `reliability-aggregator.ts:248-263`); direction: `up` if
     `value > 0.005`, `down` if `< -0.005`, else `flat`. When
     either window has `cohortSize === 0`, return
     `{ value: 0, direction: 'flat' }`.
   - `askHumanTtr.buckets[]` — bucket the resolved cohort by
     `(julianday(resolved_at) - julianday(created_at)) * 86400`
     into the 8 fixed labels with right-exclusive boundaries
     `[60, 300, 900, 3600, 14400, 43200, 86400]`. Always emit 8
     entries in the fixed order; empty cohort → all zeros.
   - `askHumanTtr.resolvedCount` — sum of buckets[].count.
   - `askHumanTtr.openCount` — `COUNT(*)` of `escalations` with
     `type='ask_human' AND created_at IN window AND resolved_at IS NULL`.
   - `askHumanTtr.maxSeconds` — `MAX((julianday(resolved_at) -
     julianday(created_at)) * 86400)` over the resolved cohort.
     0 when empty.
   - `perProfile[]` — group cohort pods by `pods.profile_name`;
     compute `podCount` and `escalatedCount` per profile;
     fold-in profiles with `podCount < 5` into a synthetic row
     with `profile = '<small profiles>'`; sort by `rate DESC`,
     ties by `podCount DESC`. Suppress synthetic row when no
     fold-in.
   - `blockerPatterns[]` — group `escalations` rows with
     `type='report_blocker' AND created_at IN window` by
     `trim(payload->>'description')` (case-sensitive, exact-string),
     skip null/empty descriptions; `LIMIT 10` ordered by
     `count DESC, description ASC`. For each pattern, fetch
     `DISTINCT pod_id` ordered by `created_at DESC LIMIT 10`.

3. **Route registration** — extend
   `packages/daemon/src/api/routes/pods.ts`. Mirror the Reliability
   route at `pods.ts:244-256`. Validation envelope and error shape
   per `design.md` → Validation rules. The handler calls
   `computeEscalationsAnalytics(db, days)`.

4. **Wiring** — `packages/daemon/src/index.ts` passes the aggregator
   into the route registration alongside the existing reliability /
   quality / cost / safety / throughput wiring.

## Touches

- `packages/shared/src/types/analytics.ts` — add new types.
- `packages/shared/src/index.ts` — re-export.
- `packages/daemon/src/pods/escalations-aggregator.ts` — new aggregator.
- `packages/daemon/src/pods/escalations-aggregator.test.ts` — co-located
  unit tests.
- `packages/daemon/src/api/routes/pods.ts` — register the new route.
- `packages/daemon/src/api/routes/pods.test.ts` — extend with route
  integration tests.
- `packages/daemon/src/index.ts` — wire the aggregator.

## Does not touch

- `packages/desktop/` — desktop consumes this contract in Brief 02.
- `packages/cli/` — no CLI surface for escalations analytics.
- `packages/escalation-mcp/`, `packages/validator/` — unrelated.
- `packages/daemon/src/db/migrations/` — no schema change in this
  phase.

## Constraints

- Follow `design.md` → Contracts verbatim. Do not widen the response.
- The three cohorts must be named distinctly and used only where
  appropriate (`design.md` → Cohort discipline). Mixing the
  cohort-pinned summary stats with the unrestricted histogram /
  pattern queries is the known footgun.
- `askHumanTtr.buckets` always emits 8 entries in the fixed label
  order, even when all are zero.
- `askHumanTtr.openCount` is point-in-time at request time and
  EXCLUDED from `buckets[]` / `resolvedCount`. Resolved-only counts
  in the histogram — open rows are surfaced separately so the
  slowest bucket isn't silently inflated as the window ages.
- `dailyHumanCountSparkline` length always equals `days`; missing
  days get `count: 0`.
- `blockerPatterns.length <= 10` always.
- Per-pattern `podIds.length <= 10` always; do not paginate, do not
  expose more.
- Synthetic `<small profiles>` row is emitted only when at least
  one profile folds in.
- Blocker description grouping is exact-string, case-sensitive,
  after `trim()`. No normalisation, no fuzzy matching.
- Use the sub-query pattern from
  `reliability-aggregator.ts:268-275` to avoid hitting
  `SQLITE_MAX_VARIABLE_NUMBER` on large cohorts.
- Reuse `buildTerminalCohortClause(days)` if a helper from prior
  phases exists (check `reliability-aggregator.ts`,
  `throughput-aggregator.ts`, `safety-aggregator.ts`). Do not split
  the predicate across conventions.
- The five `EscalationType` values touched here
  (`ask_human, report_blocker, validation_override, action_approval,
  ask_ai`) are a strict subset of the union in
  `packages/shared/src/types/escalation.ts`. `request_credential` is
  intentionally excluded everywhere; do not silently add it.

## Test expectations

`escalations-aggregator.test.ts`:

- **Empty cohort** — returns `summary.selfRecoveryRate: 1.0`,
  `cohortSize: 0`, all counts zero, sparkline of length `days` all
  zero, delta `{ value: 0, direction: 'flat' }`,
  `askHumanTtr.buckets` all zero, `resolvedCount: 0`, `openCount: 0`,
  `maxSeconds: 0`, empty `perProfile`, empty `blockerPatterns`.

- **Self-recovery math** — fixture: 10 cohort pods, 3 distinct pods
  with at least one human-attention escalation. Assert
  `selfRecoveryRate === 0.7`, `cohortSize === 10`,
  `humanAttentionPodCount === 3`.

- **Multi-escalation pod** — fixture: 1 pod with 3 `ask_human`
  rows in cohort. Assert `humanAttentionPodCount === 1` (distinct)
  but `humanAttentionCount === 3` (rows).

- **`ask_ai` exclusion from rate** — fixture: 5 cohort pods, all
  with `ask_ai` escalations only. Assert `selfRecoveryRate === 1.0`
  (ask_ai doesn't count), `askAiCount > 0`,
  `humanAttentionPodCount === 0`.

- **`request_credential` exclusion** — fixture: pod with only
  `request_credential` escalation. Assert it counts in NEITHER
  `humanAttentionCount` NOR `askAiCount`.

- **Trailing-window bucketing** — fixture with escalations at known
  timestamps inside and just-outside the 30-day window;
  outside-window rows do not appear in any window-scoped section.

- **TTR bucket boundaries** — fixtures with resolution times
  exactly at each boundary (60s, 300s, 900s, 3600s, 14400s, 43200s,
  86400s). Right-exclusive: 60.0s lands in `1–5m`, not `<1m`.
  Single-second resolution lands in `<1m`. 100000s lands in `>24h`.

- **TTR open exclusion** — fixture with `ask_human` row created in
  window, `resolved_at IS NULL`. Does NOT contribute to any bucket;
  contributes to `openCount`. Resolved row contributes to bucket
  AND `resolvedCount`, NOT to `openCount`.

- **TTR max** — fixture with two resolved `ask_human` rows: 30s
  and 7200s. Assert `maxSeconds === 7200`.

- **Per-profile sort + fold-in** — fixture with 4 profiles:
  `A` (10 pods, 5 escalated → rate 0.5),
  `B` (8 pods, 2 escalated → rate 0.25),
  `C` (3 pods, 3 escalated → rate 1.0; folds in),
  `D` (2 pods, 0 escalated → rate 0.0; folds in).
  Expected output: 3 rows. `<small profiles>` row has
  `podCount: 5, escalatedCount: 3, rate: 0.6`. Sort by rate DESC:
  `<small profiles>` (0.6), `A` (0.5), `B` (0.25). Tie-break test
  with two profiles at the same rate, lower podCount first wins
  the higher position.

- **Per-profile fold-in suppression** — fixture where every profile
  has `podCount >= 5`. Assert no `<small profiles>` row is emitted.

- **Blocker pattern grouping** — fixture with `report_blocker`
  rows: 3 with `description: "Cannot find file"`, 2 with
  `description: "Cannot find file."` (different by trailing dot),
  1 with `description: " Cannot find file "` (trims to match
  group 1), 1 with `description: ""` (skipped), 1 with no
  description (skipped). Expected output: 2 patterns —
  `"Cannot find file"` count 4, `"Cannot find file."` count 2.
  Sort by count DESC.

- **Blocker pattern pod-id cap** — fixture with one pattern hit
  by 15 distinct pods. Assert `count === 15`,
  `podIds.length === 10`, ordered by `created_at DESC`.

- **Blocker pattern not cohort-restricted** — fixture with
  `report_blocker` from a pod whose `output_mode='workspace'` (not
  in terminal cohort). The pattern still appears in
  `blockerPatterns`.

- **Sparkline not cohort-restricted** — fixture with human-attention
  escalations from a pod whose `output_mode='workspace'`. They
  appear in `dailyHumanCountSparkline` (not cohort-pinned) but NOT
  in `humanAttentionCount` (cohort-pinned).

- **Workspace exclusion from terminal cohort** — fixture with a
  pod `output_mode='workspace'` that has `ask_human` escalations.
  Pod is excluded from `cohortSize`, `humanAttentionPodCount`,
  `humanAttentionCount`, `perProfile`. Its escalations still
  contribute to `dailyHumanCountSparkline`, `askHumanTtr`, and
  `blockerPatterns` (those aren't cohort-pinned).

- **Prior-window delta** — fixture: current 30-day window has
  cohortSize 10, escalated 2 → rate 0.8. Prior 30-day window has
  cohortSize 10, escalated 5 → rate 0.5. Assert
  `selfRecoveryRateDelta.value ≈ 0.3`, `direction === 'up'`.

- **Prior-window empty cohort** — fixture: current window has
  pods, prior window has zero pods. Assert
  `selfRecoveryRateDelta === { value: 0, direction: 'flat' }`.

`pods.test.ts` (route-level, mirror Reliability block):

- Default behaviour (`/pods/analytics/escalations` with no `days`)
  uses `days=30`; structural assertion on the response shape (every
  required key present, expected lengths).
- `?days=0` → 400 with `code: 'invalid_days'`.
- `?days=-5` → 400 with `code: 'invalid_days'`.
- `?days=400` → 400 with `code: 'invalid_days'`.
- `?days=abc` → 400 with `code: 'invalid_days'`.
- `?days=90` (boundary) → 200, sparkline length 90,
  `askHumanTtr.buckets` length 8.

## Risks / pitfalls

- **Cohort-pinning footgun** — three cohorts in one endpoint.
  `summary.humanAttentionCount` is cohort-pinned;
  `dailyHumanCountSparkline` is NOT. They will diverge in
  fixtures. Tests must pin this divergence explicitly.
- **Open-row drift** — `askHumanTtr.openCount` is point-in-time;
  the same query run a minute later may return a different number
  if a pending response just landed. Document the freshness
  semantics in the aggregator comment. Do NOT cache it.
- **JSON path extraction** — `payload->>'description'` requires
  SQLite's JSON1 extension. Confirm it's compiled in (it is in
  `better-sqlite3`'s default build); the safer form
  `json_extract(payload, '$.description')` works the same and is
  used elsewhere in the codebase. Pick whichever is consistent
  with prior aggregators.
- **Description grouping case-sensitivity** — operator-grade
  intentional; if reviewers push for case-insensitive grouping,
  defer to a follow-up. Fixture must cover both
  case-and-punctuation-distinct descriptions.
- **Variable-number limit** — `SQLITE_MAX_VARIABLE_NUMBER` defaults
  to 999. Cohort sizes can exceed that. Use the sub-query pattern
  from `reliability-aggregator.ts:268-275` for any "WHERE pod_id
  IN (...)" — pass the cohort filter as a sub-query, not as
  spread params.
- **Delta arithmetic on rates** — prior-window delta is in
  *absolute fraction* (0.05 means 5pp), not relative percent.
  Document this in the aggregator comment so the desktop side
  formats it as `pp` not `%`.
- **No `EscalationType.ask_human_credential` etc.** — the union is
  exactly the 6 values in
  `packages/shared/src/types/escalation.ts`. Do not silently widen.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
