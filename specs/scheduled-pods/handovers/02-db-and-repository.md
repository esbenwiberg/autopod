# Handover: Brief 02 — DB Migration + Repository

## Status: Complete (reworked)

## What Was Done

- Created `packages/daemon/src/db/migrations/038_scheduled_jobs.sql` with the `scheduled_jobs` table, index, and `ALTER TABLE sessions ADD COLUMN scheduled_job_id`
- Created `packages/daemon/src/scheduled-jobs/scheduled-job-repository.ts` with `ScheduledJobRepository` interface and `createScheduledJobRepository()` factory
- Updated `packages/daemon/src/sessions/session-repository.ts`: added `scheduledJobId` to `NewSession`, `rowToSession()`, and the `INSERT` statement
- Updated `packages/daemon/src/test-utils/mock-helpers.ts`: added `insertTestScheduledJob()` helper
- Created `packages/daemon/src/scheduled-jobs/scheduled-job-repository.test.ts` with 13 tests — all pass

## Files Changed

| File | Change |
|------|--------|
| `packages/daemon/src/db/migrations/038_scheduled_jobs.sql` | Created — table + index + sessions column |
| `packages/daemon/src/scheduled-jobs/scheduled-job-repository.ts` | Created — full CRUD + listDue/listOverdue/listPendingCatchup/countActiveSessions |
| `packages/daemon/src/scheduled-jobs/scheduled-job-repository.test.ts` | Created — 13 tests (includes FK nullify test) |
| `packages/daemon/src/sessions/session-repository.ts` | Added `scheduledJobId` to `NewSession`, insert SQL, and `rowToSession()` mapper |
| `packages/daemon/src/test-utils/mock-helpers.ts` | Added `insertTestScheduledJob()` |

## Key Design Decisions

- The `datetime(next_run_at)` wrapper in `listDue`/`listOverdue` queries is needed because ISO 8601 timestamps (with `T` separator) don't compare correctly against SQLite's `datetime('now')` format (which uses space) in plain string comparison.
- The `delete()` method nullifies `sessions.scheduled_job_id` before deleting the job, to avoid `SQLITE_CONSTRAINT_FOREIGNKEY` failures when sessions reference the job being deleted. The migration uses `REFERENCES scheduled_jobs(id)` without `ON DELETE SET NULL`, so this is handled in application code.

## Rework Fix

In the first attempt, `DELETE /scheduled-jobs/:id` returned 500 when sessions had
`scheduled_job_id = <jobId>`. Fixed by adding a `UPDATE sessions SET scheduled_job_id = NULL`
step before the `DELETE FROM scheduled_jobs` in the repository `delete()` method.

## Acceptance Criteria Met

- [x] Migration applies cleanly via `createTestDb()`
- [x] All 13 ScheduledJobRepository tests pass
- [x] `sessions.scheduled_job_id` column exists and is returned in `rowToSession()`
- [x] `insertTestScheduledJob()` works
- [x] `delete()` handles FK constraint by nullifying sessions.scheduled_job_id first
- [x] All 1176 daemon tests pass

## Notes

All lint errors in files modified during this brief have been fixed.
