# Handover — abundant-hummingbird (Brief 04: Ingestion Writers)

## What was built

Two ingestion-time detection sites instrumented to write `safety_events` rows.

### 1. `issue-watcher-service.ts`
- Added `safetyEventsRepo?: SafetyEventsRepository` to `IssueWatcherServiceDependencies`
- In `processCandidate`, after all `processContent` calls complete:
  - Writes one `safety_events` row per injection threat (`source='issue_body'`, `kind='injection'`)
  - Writes one row per PII pattern hit (`kind='pii'`, `severity=null`) via `collectPiiPatternNames(originalAll)`
  - Tracks all inserted row IDs in `safetyRowIds`
  - `payloadExcerpt` = first 256 chars of concatenated sanitized text (title + body + ACs)
- After `podManager.createSession` succeeds, calls `safetyEventsRepo.attachPodId(safetyRowIds, pod.id)`
- If `createSession` throws, rows remain `pod_id=NULL` permanently (forward-only telemetry, no rollback)

### 2. `api/routes/pods.ts`
- Added `safetyEventsRepo?: SafetyEventsRepository` as final parameter to `podRoutes`
- In POST /pods, replaced inline `processContent(...).text` calls with captured results
- After Zod validation, before `createSession`: writes per-threat injection rows and per-pattern PII rows with `source='pod_input'`, `pod_id=NULL` permanently
- `payloadExcerpt` = first 256 chars of concatenated sanitized fields

### 3. `api/server.ts`
- `podRoutes(...)` call extended to pass `deps.safetyEventsRepo` as 10th argument

### 4. `index.ts`
- `safetyEventsRepo` passed to `createIssueWatcherService`

## Deviations from brief

One deviation:
- **Test for `seriesDescription` PII** — the brief specified "POST /pods with PII in `body.seriesDescription`", but `seriesDescription` is not in `createPodRequestSchema`, so Zod strips it before the sanitization block runs. The test instead uses `body.task` containing an email address, which covers the same PII code path. The sanitization code for `seriesDescription` in `pods.ts` is preserved as-is (it was dead code before and remains so).

## Files owned — do not modify without good reason

- `packages/daemon/src/issue-watcher/issue-watcher-service.ts` — `safetyEventsRepo` DI wiring + detection/backfill logic
- `packages/daemon/src/api/routes/pods.ts` — `safetyEventsRepo` param + POST /pods write site

## Contract notes for downstream pods

### For Brief 05 (analytics endpoint):
- `safety_events` rows with `source='issue_body'` and `source='pod_input'` are now being written
- Issue-watcher rows: `pod_id` will be set (post-backfill) for normal cases; `pod_id=NULL` only when `createSession` failed
- POST /pods rows: `pod_id` is always `NULL` — aggregate as `__pre_creation__` in the drill
- `podRoutes` now takes a 10th optional parameter `safetyEventsRepo?: SafetyEventsRepository` — Brief 05 adds new routes to the same function; be aware of the updated signature when merging

### File overlap with Brief 05:
- `packages/daemon/src/api/routes/pods.ts` — Brief 05 adds `GET /pods/analytics/safety` and `POST /audit-chain/verify` routes to this file. Brief 04 has landed first; Brief 05's diff will be minimal (just the new route registrations).
- `packages/daemon/src/api/routes/pods.test.ts` — Same overlap. Brief 05 can append new `describe` blocks.

## Discovered constraints

- `seriesDescription` is absent from `createPodRequestSchema` — any sanitization/safety instrumentation for that field at the POST /pods handler is dead code. Do not remove the field from `pods.ts` (it may be added to the schema later), but do not write tests that assume it works through the HTTP layer.
- `safetyEventsRepo.insert()` returns `number` (rowid) — this is the interface Brief 02 established. The backfill pattern depends on it.
