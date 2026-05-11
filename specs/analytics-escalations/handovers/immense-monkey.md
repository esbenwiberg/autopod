# Handover: analytics-escalations Brief 01 (immense-monkey)

## What was built

Implemented `GET /pods/analytics/escalations?days=N` — the daemon-side
half of the analytics-escalations spec. Pure read/aggregate path backed
by the existing `pods` and `escalations` tables. No schema changes.

**Files added:**
- `packages/daemon/src/pods/escalations-aggregator.ts` —
  `computeEscalationsAnalytics(db, days)`: terminal cohort self-recovery
  rate + prior-window delta, daily human-attention sparkline, ask_human
  TTR histogram (8 log-scale buckets, right-exclusive), per-profile fold-in
  (`<small profiles>` when `podCount < 5`), top-10 blocker pattern table
  with pod-ID cap of 10.
- `packages/daemon/src/pods/escalations-aggregator.test.ts` — 23 unit
  tests covering all contract edge cases (empty cohort, self-recovery math,
  multi-escalation pod, ask_ai / request_credential exclusion, TTR bucket
  boundaries, open-row exclusion, per-profile fold-in + sort, blocker
  pattern grouping, cohort vs. window distinctions).

**Files modified:**
- `packages/shared/src/types/analytics.ts` — added
  `HumanAttentionKind`, `EscalationsSummary`, `AskHumanTtrBucket`,
  `AskHumanTtr`, `PerProfileEscalation`, `BlockerPattern`,
  `EscalationsAnalyticsResponse`.
- `packages/shared/src/index.ts` — re-exported the seven new types.
- `packages/daemon/src/api/routes/pods.ts` — registered the route,
  mirroring the Reliability/Throughput pattern. Days validation: 1–365,
  default 30. Error message matches other analytics routes:
  `"days must be a positive integer <= 365"`.
- `packages/daemon/src/api/routes/pods.test.ts` — added 6 route
  integration tests (shape assertion, days validation, boundary check).

## Contracts Brief 02 must consume verbatim

The TypeScript contract is in `packages/shared/src/types/analytics.ts`
(lines after `AuditChainVerifyResponse`). The wire format is:

```
EscalationsAnalyticsResponse {
  summary: EscalationsSummary
  askHumanTtr: AskHumanTtr
  perProfile: PerProfileEscalation[]
  blockerPatterns: BlockerPattern[]
}
```

Key invariants the Swift Codable mirror must handle:
- `summary.dailyHumanCountSparkline` is always `length === days`.
- `askHumanTtr.buckets` is always length 8 in the fixed label order.
- `blockerPatterns.length <= 10` always; each `podIds.length <= 10`.
- `selfRecoveryRateDelta.value` is an **absolute fraction** (e.g. 0.05 = +5pp),
  not a percent. Format as `%+.0fpp` in the UI.
- `summary.selfRecoveryRate` is `1.0` (not 0.0) when `cohortSize === 0`.

## Files Brief 02 should NOT modify

- `packages/daemon/src/pods/escalations-aggregator.ts`
- `packages/daemon/src/pods/escalations-aggregator.test.ts`
- `packages/daemon/src/api/routes/pods.ts` (escalations route section)
- `packages/shared/src/types/analytics.ts` (escalations types section)

## Post-validation fixes (attempt 1)

Two medium issues flagged by the task reviewer were resolved:
1. **Dead `emptyResponse` function** — removed. It was defined but never called from
   `computeEscalationsAnalytics`; all SQL queries already run unconditionally and handle
   empty cohorts inline (`cohortSize === 0 → rate 1.0`, etc.).
2. **Non-portable `SELECT DISTINCT pod_id ... ORDER BY created_at DESC`** — the
   `podIdsForPatternStmt` query now uses `GROUP BY pod_id ORDER BY MAX(created_at) DESC`
   which is standard-SQL compliant and removes the implicit dependency on SQLite's
   sort-before-dedup execution model.

## Discovered constraints / landmines

- **`terminalCohortWhere()` is local to each aggregator** — each aggregator
  (reliability, throughput, escalations) has its own private copy with a
  `// keep in sync with:` comment. Do not extract into a shared module
  without touching all three aggregators.
- **TTR bucketing uses ms-rounded julianday result** — raw `(julianday(resolved_at) - julianday(created_at)) * 86400.0` has float noise; the aggregator rounds to 3 decimal places (`Math.round(secs * 1000) / 1000`) before bucketing. This is intentional and tested.
- **Three distinct cohorts** — mixing them is the known footgun documented
  in the aggregator header comment. `humanAttentionCount` is cohort-pinned;
  `dailyHumanCountSparkline` and `blockerPatterns` are NOT.
- **`AnalyticsCardKind.swift` collision** — Phase 5a (analytics-throughput
  Brief 02) must be merged before starting escalations Brief 02 to avoid
  a 3-way conflict on the enum and exhaustive-switch sites.
