# Handover: Brief 03 — Scheduler + Manager

## Status: Complete

## What Was Done

- Added `cron-parser: ^4.9.0` to `packages/daemon/package.json`
- Created `packages/daemon/src/scheduled-jobs/scheduled-job-manager.ts` with `createScheduledJobManager()` factory implementing all methods: `create`, `list`, `get`, `update`, `delete`, `runCatchup`, `skipCatchup`, `trigger`, `reconcileMissedJobs`, `tick`
- Created `packages/daemon/src/scheduled-jobs/scheduled-job-scheduler.ts` with `createScheduledJobScheduler()` — calls `reconcileMissedJobs()` on startup, runs tick every 60s, interval is `.unref()`'d
- Updated `packages/daemon/src/sessions/session-manager.ts` `createSession()` to pass `scheduledJobId` through to `sessionRepo.insert()`
- Updated `packages/daemon/src/index.ts` to instantiate manager + scheduler, pass manager to `createServer`, start scheduler after listen, stop scheduler in shutdown
- Updated `packages/daemon/src/api/server.ts` to accept `scheduledJobManager?: ScheduledJobManager` in `ServerDependencies`
- Created 18 manager tests + 4 scheduler tests — all pass

## Files Changed

| File | Change |
|------|--------|
| `packages/daemon/package.json` | Added `cron-parser` dependency |
| `packages/daemon/src/scheduled-jobs/scheduled-job-manager.ts` | Created |
| `packages/daemon/src/scheduled-jobs/scheduled-job-manager.test.ts` | Created — 18 tests |
| `packages/daemon/src/scheduled-jobs/scheduled-job-scheduler.ts` | Created |
| `packages/daemon/src/scheduled-jobs/scheduled-job-scheduler.test.ts` | Created — 4 tests |
| `packages/daemon/src/sessions/session-manager.ts` | Added `scheduledJobId` pass-through |
| `packages/daemon/src/index.ts` | Wired scheduler/manager, start/stop lifecycle |
| `packages/daemon/src/api/server.ts` | Added `scheduledJobManager` to `ServerDependencies` |

## Key Design Decisions

- `SCHEDULER_USER_ID = 'scheduler'` sentinel for sessions created by the scheduler
- The `trigger()` method (for `POST /:id/trigger`) uses the same fire logic as `tick()` but always fires regardless of schedule state (still respects skip-if-active)
- Tests mock the `sessionManager.createSession` to also insert a real session row into the DB so FK constraints on `last_session_id` are satisfied

## Acceptance Criteria Met

- [x] `create()` rejects invalid cron expressions with 400
- [x] `reconcileMissedJobs()` marks overdue jobs + emits events
- [x] `tick()` fires due jobs, skips active, skips catchup-pending
- [x] `tick()` per-job errors don't stop other jobs
- [x] `runCatchup()` / `skipCatchup()` work correctly with 409/400 errors
- [x] Scheduler start calls reconciler; interval is `.unref()`'d
- [x] All 1089 tests pass

## Notes for Brief 04

Brief 04 creates `routes/scheduled-jobs.ts`. The route file should import `ScheduledJobManager` from `../scheduled-jobs/scheduled-job-manager.js`. The `server.ts` already has `scheduledJobManager?: ScheduledJobManager` in `ServerDependencies` — Brief 04 just needs to register the routes when it's present.
