# Handover: Brief 02 — DB Migration + Repository

## Status: Complete

## What Was Done

- Created `packages/daemon/src/db/migrations/038_scheduled_jobs.sql` with the `scheduled_jobs` table, index, and `ALTER TABLE sessions ADD COLUMN scheduled_job_id`
- Created `packages/daemon/src/scheduled-jobs/scheduled-job-repository.ts` with `ScheduledJobRepository` interface and `createScheduledJobRepository()` factory
- Updated `packages/daemon/src/sessions/session-repository.ts`: added `scheduledJobId` to `NewSession`, `rowToSession()`, and the `INSERT` statement
- Updated `packages/daemon/src/test-utils/mock-helpers.ts`: added `insertTestScheduledJob()` helper
- Created `packages/daemon/src/scheduled-jobs/scheduled-job-repository.test.ts` with 12 tests — all pass

## Files Changed

| File | Change |
|------|--------|
| `packages/daemon/src/db/migrations/038_scheduled_jobs.sql` | Created — table + index + sessions column |
| `packages/daemon/src/scheduled-jobs/scheduled-job-repository.ts` | Created — full CRUD + listDue/listOverdue/listPendingCatchup/countActiveSessions |
| `packages/daemon/src/scheduled-jobs/scheduled-job-repository.test.ts` | Created — 12 tests |
| `packages/daemon/src/sessions/session-repository.ts` | Added `scheduledJobId` to `NewSession`, insert SQL, and `rowToSession()` mapper |
| `packages/daemon/src/test-utils/mock-helpers.ts` | Added `insertTestScheduledJob()` |

## Key Design Decisions

- The `datetime(next_run_at)` wrapper in `listDue`/`listOverdue` queries is needed because ISO 8601 timestamps (with `T` separator) don't compare correctly against SQLite's `datetime('now')` format (which uses space) in plain string comparison.

## Acceptance Criteria Met

- [x] Migration applies cleanly via `createTestDb()`
- [x] All 12 ScheduledJobRepository tests pass
- [x] `sessions.scheduled_job_id` column exists and is returned in `rowToSession()`
- [x] `insertTestScheduledJob()` works
- [x] All 1067 existing daemon tests still pass

## Notes for Brief 03

Brief 03 needs to add `cron-parser` to `packages/daemon/package.json`, then implement `ScheduledJobManager` and `ScheduledJobScheduler`. The manager imports `createScheduledJobRepository` from `../scheduled-jobs/scheduled-job-repository.js`. The `sessions/index.ts` barrel may need to be updated if Brief 03 adds exports there.
