---
title: "Instrument issue-watcher + POST /pods free-text detections"
depends_on: [ 01-add-safety-migrations-and-types, 02-add-safety-events-repository-and-action-writers ]
acceptance_criteria:
  - type: cmd
    outcome: rg -l 'safetyEventsRepo|safety_events' packages/daemon/src/issue-watcher/issue-watcher-service.ts packages/daemon/src/api/routes/pods.ts → ≥2 matches (one per file)
    hint: rg -l 'safetyEventsRepo|safety_events' packages/daemon/src/issue-watcher/issue-watcher-service.ts packages/daemon/src/api/routes/pods.ts
    polarity: expect-output
touches:
  - packages/daemon/src/issue-watcher/issue-watcher-service.ts
  - packages/daemon/src/issue-watcher/issue-watcher-service.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/index.ts
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/safety/
  - packages/daemon/src/actions/
  - packages/daemon/src/pods/
  - packages/desktop/
---

## Task

Instrument the two ingestion-time detection sites:

1. **`issue-watcher-service.ts`** — at the existing threat-detection
   block (lines ~137-167), in addition to the current log line, write
   per-pattern `safety_events` rows with `source='issue_body'`.
   `pod_id` is **NULL initially** (the pod doesn't exist yet at
   detection time). After `podManager.createSession` returns, call
   `safetyEventsRepo.attachPodId(rowIds, newPodId)` to backfill the
   association. Track the inserted row ids so the backfill targets
   exactly those rows.

2. **`api/routes/pods.ts` POST /pods** — at the free-text
   sanitization block (lines ~115-127), if any of `body.task`,
   `body.seriesName`, `body.seriesDescription` produce threats or PII
   patterns, write per-pattern `safety_events` rows with
   `source='pod_input'`. `pod_id` stays **NULL permanently** — at
   this point the request has not allocated a pod, and unlike
   issue-watcher there's no clean post-creation hook to backfill
   from. Brief 05's aggregator buckets these under
   `__pre_creation__`.

## Touches

- `packages/daemon/src/issue-watcher/issue-watcher-service.ts` —
  capture `processContent` result, call `safetyEventsRepo.insert`
  per pattern (track ids), and call `attachPodId` after pod creation
  succeeds.
- `packages/daemon/src/issue-watcher/issue-watcher-service.test.ts`
  — extend.
- `packages/daemon/src/api/routes/pods.ts` — write `safety_events`
  rows at the existing sanitization block. No new helper; inline.
- `packages/daemon/src/api/routes/pods.test.ts` — extend with a POST
  /pods test that verifies a row is written when the body contains
  an injection pattern.
- `packages/daemon/src/index.ts` — pass `safetyEventsRepo` into the
  issue-watcher factory and into the routes plugin.

## Does not touch

- `packages/daemon/src/db/migrations/` — Brief 01 owns.
- `packages/daemon/src/safety/` — Brief 02 owns. Use the existing
  repo interface.
- `packages/daemon/src/actions/` — Brief 02.
- `packages/daemon/src/pods/` — Brief 03.
- `packages/desktop/` — Brief 06.

## Constraints

- **`pod_id` semantics**:
  - Issue-watcher: write with `pod_id=NULL`, then `attachPodId(...)`
    after `createSession` succeeds. If creation throws (rare — see
    error handling note below), the rows stay attached to NULL and
    aggregate under `__pre_creation__`. That's acceptable.
  - POST /pods: stays NULL forever. The request returns the new pod
    id but the route already allocates the pod via separate machinery
    and there is no clean place to backfill. Bucket as
    `__pre_creation__` in Brief 05.
- **One row per pattern hit** (same rule as Briefs 02 + 03).
- **`payload_excerpt`**: 256 chars post-sanitize. The issue-body and
  the pod-input free-text fields both carry user-readable strings.
  Concatenate the threat-bearing field's sanitized text and slice.
- **Issue-watcher backfill ordering**: insert detection rows BEFORE
  `createSession` so you have ids to backfill. `createSession` may
  fail (queue full, validation reject, etc.) — in that case the rows
  remain `pod_id=NULL`. Do not rollback the safety inserts; they're
  forward-only telemetry.
- **POST /pods error envelope**: the existing route validation
  envelope is unchanged. The safety write happens *after* the body
  passes Zod validation but *before* the pod is queued — same point
  where sanitization happens today.
- **Don't add a route for the writer**: the writer is in-process; no
  HTTP surface change in this brief. Brief 05 owns the new
  `/pods/analytics/safety` and `/audit-chain/verify` routes.
- **Insert-and-collect-ids**: the repo's `insert` method should
  return the inserted row id. If it doesn't yet (Brief 02 added it),
  extend the interface in this brief — that's a single field
  addition. Document the change here in the test expectations.

## Test expectations

### `issue-watcher-service`
- **Issue body with injection** — issue text containing one threat
  pattern produces one `safety_events` row with
  `source='issue_body', pod_id=NULL` at detection time. After
  `createSession` returns pod `xyz12345`, `attachPodId` updates the
  row's `pod_id` to `xyz12345`. Verify final row has the pod id.
- **Issue body with PII** — same path with PII patterns; rows have
  `kind='pii', severity=NULL`.
- **Clean issue** — no rows written.
- **`createSession` fails** — rows remain `pod_id=NULL`. The
  existing failure handling in the watcher is unchanged.
- **Multiple patterns** — N matches → N rows, all attributed to the
  same pod after backfill.

### `api/routes/pods.ts`
- **POST /pods with injection in `body.task`** — 200 (or whatever
  the existing happy path returns) AND one `safety_events` row with
  `source='pod_input', pod_id=NULL, kind='injection'`. Existing
  sanitization behaviour is unchanged: the threat-bearing input is
  redacted/quarantined before being stored on the pod row.
- **POST /pods with PII in `body.seriesDescription`** — same shape,
  `kind='pii'`.
- **POST /pods with clean body** — no rows written; existing
  behaviour unchanged.
- **Test must use `app.inject()`** mirror the existing
  POST `/pods` route test pattern in
  `pods.test.ts`. Use `createTestDb()` for the underlying repo.

## Risks / pitfalls

- **File overlap with Brief 05** on `api/routes/pods.ts` and
  `api/routes/pods.test.ts`. This is the reason for the brief
  ordering: Brief 05 must merge after Brief 04. If Brief 04 lands
  first, Brief 05's diff stays minimal (just the new route
  registrations); if reversed, expect a merge conflict.
- **Backfill race**: between the `safety_events` inserts and
  `attachPodId`, an aggregation read could observe rows with
  `pod_id=NULL` that will *eventually* be attributed. That's fine —
  the aggregator either attributes correctly on a later read, or the
  row falls under `__pre_creation__` if `createSession` failed.
  Don't try to make this transactional.
- **Hot-path cost**: issue-watcher and POST /pods are both
  request-path. Per-pattern inserts are cheap (single SQL statement
  each), but if the body is enormous, multiple-pattern detection
  could bloat. Acceptable for operator-grade telemetry; flag in
  follow-up if it shows up in profiles.
- **Don't widen sanitization**: the sanitize/quarantine logic itself
  is unchanged (Non-goal in `purpose.md`). Only the *visibility* —
  the writer — is added. Resist the urge to "improve" the
  sanitizer in this brief.
- **`__pre_creation__` is a render-time bucket**, not a stored
  value. Storage is `pod_id=NULL`. The Brief 05 aggregator maps NULL
  → `__pre_creation__` in its response.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run `./scripts/validate.sh`; build + lint + tests must pass.
3. Commit and push.
