---
title: "Add /pods/analytics/safety + POST /audit-chain/verify endpoints"
depends_on: [ 01-add-safety-migrations-and-types, 04-instrument-ingestion-detections ]
acceptance_criteria:
  - type: api
    outcome: GET /pods/analytics/safety?days=30 → 200 with body.summary, body.byPattern, body.bySource, body.quarantineHistogram, body.byPod, body.networkPolicy, body.auditChain present
    hint: GET /pods/analytics/safety?days=30
  - type: api
    outcome: GET /pods/analytics/safety (no query) → 200 (defaults to days=30) with same shape
    hint: GET /pods/analytics/safety (no query)
  - type: api
    outcome: GET /pods/analytics/safety?days=0 → 400 with code:'invalid_days'
    hint: GET /pods/analytics/safety?days=0
  - type: api
    outcome: POST /audit-chain/verify → 200 with body.valid:bool, body.totalPods:number, body.totalEntries:number, body.ranAt present
    hint: POST /audit-chain/verify
touches:
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/safety/safety-aggregator.ts
  - packages/daemon/src/safety/safety-aggregator.test.ts
  - packages/daemon/src/actions/audit-chain-verifier.ts
  - packages/daemon/src/actions/audit-chain-verifier.test.ts
  - packages/daemon/src/actions/audit-chain-verifications-repository.ts
  - packages/daemon/src/actions/audit-chain-verifications-repository.test.ts
  - packages/daemon/src/index.ts
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/safety/safety-events-repository.ts
  - packages/daemon/src/actions/audit-repository.ts
  - packages/daemon/src/pods/
  - packages/daemon/src/issue-watcher/
  - packages/desktop/
---

## Task

Ship the read side: one composite analytics endpoint and the
fleet-wide audit-chain verifier.

1. **`safety-aggregator.ts`** — pure function from raw query rows
   (terminal cohort) to `SafetyAnalyticsResponse`. Takes
   `safetyEventsRepo`, the existing `auditAuditRepository` (for
   `quarantine_score` histogram + `pii_detected` legacy bucket), the
   `pods` table (for `network_policy_resolved` distribution + cohort
   filter), and `auditChainVerificationsRepo` (for the latest result
   widget). Returns the full `SafetyAnalyticsResponse` shape from
   `design.md` → Contracts.

2. **`audit-chain-verifier.ts`** — fleet-wide walker. Selects
   `DISTINCT pod_id FROM action_audit`, calls the existing
   `auditRepo.verifyAuditChain(podId)` for each, aggregates results,
   returns `AuditChainVerifyResponse`. Persists the result to
   `audit_chain_verifications` via the new repo.

3. **`audit-chain-verifications-repository.ts`** — `record(result)`
   and `latest()`. Trivial wrapper over the new table.

4. **Routes**:
   - `GET /pods/analytics/safety?days=N` → calls the aggregator.
   - `POST /audit-chain/verify` → calls the verifier, persists the
     result, returns the response.

   Both routes mirror the validation envelope used by the Cost,
   Reliability, and Quality routes (`pods.ts:237-277`).

## Touches

- `packages/daemon/src/safety/safety-aggregator.ts` (new) — pure
  aggregation. Reuses `buildTerminalCohortClause(days)` if Phase 2
  extracted it; otherwise inline the predicate identically and note
  it.
- `packages/daemon/src/safety/safety-aggregator.test.ts` (new) —
  coverage against `createTestDb()` with seeded rows across all
  output shapes.
- `packages/daemon/src/actions/audit-chain-verifier.ts` (new) —
  fleet walker; depends on existing per-pod
  `auditRepo.verifyAuditChain`.
- `packages/daemon/src/actions/audit-chain-verifier.test.ts` (new) —
  coverage for valid + invalid + empty fleet cases.
- `packages/daemon/src/actions/audit-chain-verifications-repository.ts`
  (new) — `record` + `latest`.
- `packages/daemon/src/actions/audit-chain-verifications-repository.test.ts`
  (new).
- `packages/daemon/src/api/routes/pods.ts` — register the two new
  routes alongside the existing analytics block. Days validation
  envelope identical to the others.
- `packages/daemon/src/api/routes/pods.test.ts` — extend with
  route-level integration tests modelled on
  `pods.test.ts:119-360` (Reliability block).
- `packages/daemon/src/index.ts` — wire the aggregator + verifier +
  new repo.

## Does not touch

- `packages/daemon/src/db/migrations/` — Brief 01.
- `packages/daemon/src/safety/safety-events-repository.ts` — Brief
  02 owns it; consume the existing read methods only.
- `packages/daemon/src/actions/audit-repository.ts` — consume the
  existing per-pod `verifyAuditChain` method; do not modify.
- `packages/daemon/src/pods/` — Brief 03.
- `packages/daemon/src/issue-watcher/` — Brief 04.
- `packages/desktop/` — Brief 06.

## Constraints

- **Endpoint contract** is locked at `design.md` → Contracts. Do not
  rename fields, change cardinality, or "improve" the shape. Brief
  06 mirrors verbatim.
- **Validation envelope**: `days` defaults to 30, valid range 1..365.
  `days < 1` → `400 { error, code: 'invalid_days' }`. `days > 365`
  → same code. Mirror `pods.ts:266+` exactly.
- **Cohort filter**: every section uses the terminal cohort
  (`output_mode != 'workspace' AND status IN ('complete','killed',
  'failed') AND completed_at IN window`). Reuse the existing helper
  if Phase 2 extracted it; else inline the same predicate. Apply to
  the injection table and the network-policy distribution too.
- **`byPattern` sources are mixed**: PII pattern rows come from
  `safety_events kind='pii'` (forward-only) AND legacy
  `action_audit.pii_detected=1 AND pii_categories=NULL` rows
  (bucket as `unknown`). Injection pattern rows come exclusively
  from `safety_events kind='injection'`.
- **`quarantineHistogram`**: 10 fixed buckets `[0.0..0.1, 0.1..0.2,
  ..., 0.9..1.0]`. Empty buckets emit `count: 0`. Source:
  `action_audit.quarantine_score`. The 0.7+ buckets are flagged
  high-risk in the UI; the response just supplies the counts.
- **`byPod` cardinality**: top 50 by `lastEventAt DESC`. Pods with
  `pod_id=NULL` aggregated under sentinel
  `__pre_creation__` with `profile=null`. Each entry's
  `topInjections` is up to 5 most recent.
- **`networkPolicy` bucketing**: read
  `pods.network_policy_resolved` over the cohort. NULL value (pre-
  migration / pre-Brief-03 pods) → `unknown` bucket. Buckets:
  `'allow-all' | 'restricted' | 'deny-all' | 'unknown'`.
- **`auditChain` widget**: read `auditChainVerificationsRepo.latest()`.
  `null` when no row exists; `valid: null, totalPods: null,
  totalEntries: null, lastVerifiedAt: null, firstMismatch: null`
  shape. Otherwise populated from the latest row.
- **Verify endpoint persistence**: every POST /audit-chain/verify
  call writes a row to `audit_chain_verifications`. Multiple
  concurrent calls are unlikely; if they happen, both rows land —
  no de-dupe. The widget always reads `latest()`.
- **No auth gate change**: the routes inherit the existing auth
  plugin. In dev (`NODE_ENV !== 'production'`), all tokens accepted.
  Don't add a new auth requirement.
- **Performance**: `safety_events` has the indexes Brief 01 added.
  Aggregation queries should hit `(kind, created_at)` and
  `(pod_id, created_at)`. The verifier walks one chain per pod;
  fleet of 1000 pods is fine. If a pod's chain has thousands of
  rows, the existing `verifyAuditChain` already streams — don't
  re-implement.
- **`firstMismatch`** in the verifier: stop walking after the first
  mismatch. Record `{ podId, rowId, reason }` and return.

## Test expectations

### `safety-aggregator`
- **Empty fleet** — `totalEvents=0`, all sub-arrays empty arrays,
  `quarantineHistogram` 10 entries all zero, `networkPolicy` empty
  array, `auditChain` shape with all null fields.
- **Mixed populated** — seed `safety_events` (mixed kinds + sources
  + patterns), seed `action_audit` (with and without
  `pii_categories`), seed pods with `network_policy_resolved` set
  and unset; assert every section of the response.
- **Cohort filter** — pod with `output_mode='workspace'` MUST NOT
  appear in any aggregation; pod with `status='running'` MUST NOT
  appear; pod with `completed_at` outside window MUST NOT appear.
- **Legacy `pii_categories=NULL` bucket** — seed an `action_audit`
  row with `pii_detected=1, pii_categories=NULL`; result includes a
  `byPattern` entry `{kind: 'pii', patternName: 'unknown', count: 1}`.
- **`__pre_creation__` aggregation** — seed two `safety_events` rows
  with `pod_id=NULL`; `byPod` includes one entry `{podId:
  '__pre_creation__', profile: null, eventCount: 2, ...}`.
- **`deltaVsPrior`** — direction up/down/flat math.
- **Sparkline length** — exactly `days` entries; empty days
  zero-filled.

### `audit-chain-verifier`
- **All valid** — three pods each with chains, all hashes match;
  `valid: true, totalPods: 3, totalEntries: <sum>, firstMismatch:
  null`.
- **One pod invalid** — one chain has a tampered row; `valid: false,
  firstMismatch: { podId: <that pod>, rowId: <that row>, reason:
  <hash mismatch / prev_hash mismatch> }`. The reason string is
  whatever the per-pod verifier returns; preserve verbatim.
- **Empty fleet** — no `action_audit` rows; `valid: true,
  totalPods: 0, totalEntries: 0`. (No rows means nothing to
  invalidate.)
- **Persistence** — calling the verifier writes one row to
  `audit_chain_verifications`.

### `audit-chain-verifications-repository`
- `record` + `latest` round-trip.
- `latest()` on empty table returns `null`.

### Routes (`pods.test.ts`)
- 200 happy path on `?days=30`.
- 200 with no query (defaults to 30).
- 400 on `days=0` and `days=400` with `code: 'invalid_days'`.
- POST `/audit-chain/verify` returns the verifier's result and the
  follow-up GET picks up the persisted widget data.
- Error envelope shape matches existing routes.
- Use `createTestDb()` for real SQL through the stack.

## Risks / pitfalls

- **Cohort drift**: every section needs the same cohort filter.
  Easy to forget on one section (`networkPolicy`, `byPod`
  `topInjections`). Test with one out-of-cohort row that should be
  filtered everywhere.
- **PII pattern source duplication**: a row could appear in BOTH
  `safety_events kind='pii'` AND `action_audit pii_categories='[...]'`
  (Brief 02 writes both for the action-engine path). Decide once:
  the canonical source is `safety_events` for forward rows;
  `action_audit` is the legacy bucket only when
  `pii_categories=NULL`. Document in code; test with a row that has
  both populated and assert only one count.
- **Histogram edge cases**: `quarantine_score=1.0` lands in
  `[0.9..1.0]` (the last bucket is inclusive of 1.0). Test the
  boundary.
- **`firstMismatch` propagation**: the per-pod verifier returns
  some shape today; preserve `reason` verbatim. Don't rewrite the
  reason string — the widget surfaces it raw.
- **Endpoint registration ordering**: register the two new routes
  near the other analytics routes, not at the top of the file.
  Existing Cost / Reliability / Quality block is the anchor.
- **Verifier is potentially slow** on large `action_audit` tables
  (full table scan for `DISTINCT pod_id`). The route is intended to
  be on-demand (the user clicks "Verify now"). Don't make it a
  background job in this brief; that's a follow-up.
- **Auth route**: `POST /audit-chain/verify` uses the same auth
  plugin as the rest of the API. Don't add a CSRF token or
  rate-limit beyond what's already plugged in.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run `./scripts/validate.sh`; build + lint + tests must pass.
3. Commit and push.
