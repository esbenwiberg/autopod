# Validation Plan: Scheduled Pods

## Integration Test Scenarios

### 1. Create + fire a scheduled job

1. `POST /scheduled-jobs` with a cron expression that fires every minute (`* * * * *`)
2. `GET /scheduled-jobs/:id` — verify `nextRunAt` is in the future
3. Wait for scheduler tick (or call `manager.tick()` directly in test)
4. Verify a new session was created with `scheduledJobId` set
5. `GET /scheduled-jobs/:id` — verify `lastRunAt` is set and `nextRunAt` advanced

### 2. Skip-if-active logic

1. Create a scheduled job
2. Manually set `next_run_at` to the past in DB
3. Ensure an active session exists for the job
4. Call `manager.tick()`
5. Verify no new session was created
6. Verify `nextRunAt` was NOT advanced (job stays overdue for the next tick)

Wait — actually, should we advance `nextRunAt` even when skipping? If we don't, the
job will try to fire every tick until the active session clears. That's the correct
behavior — we want it to fire as soon as the previous run completes. So: **do NOT
advance `nextRunAt` when skipping due to active session.** The tick will retry on
the next 60s interval.

### 3. Startup reconciler marks overdue jobs

1. Insert a job with `next_run_at` set to 1 hour ago, `catchup_pending = 0`
2. Call `manager.reconcileMissedJobs()`
3. Verify `catchup_pending = 1` in DB
4. Verify `scheduled_job.catchup_requested` event was emitted

### 4. Catch-up run flow

1. Set up job with `catchup_pending = 1`
2. `POST /scheduled-jobs/:id/catchup`
3. Verify session created, `catchup_pending = 0`, `nextRunAt` advanced
4. Verify returned body is a valid `Session` object

### 5. Skip catch-up flow

1. Set up job with `catchup_pending = 1`
2. `DELETE /scheduled-jobs/:id/catchup`
3. Verify `catchup_pending = 0`, `nextRunAt` advanced, no session created

### 6. Catchup 409 when not pending

1. Job with `catchup_pending = 0`
2. `POST /scheduled-jobs/:id/catchup` → expect 409

### 7. Invalid cron expression

1. `POST /scheduled-jobs` with `cronExpression: "not a cron"` → expect 400

## Manual Verification Steps

1. **Start daemon locally** with `NODE_ENV=development`
2. **Create a scheduled job** via CLI:
   ```bash
   ap schedule create default "test job" "* * * * *" "echo hello"
   ```
3. **Verify** `ap schedule list` shows the job
4. **Wait ~60s** — verify a session appears in `ap session list` with the task "echo hello"
5. **Stop daemon, wait 2 min, restart daemon**
6. **Verify** macOS notification fires: "test job was last run X minutes ago. Run now?"
7. **Click Run Now** — verify a session is created
8. **Verify** `ap schedule list` shows `catchupPending: false` and updated `nextRunAt`
9. **Disable job**: `ap schedule disable <id>` — wait 60s — verify no new sessions
10. **Delete job**: `ap schedule delete <id>` — verify removed from list

## Edge Cases to Test

- Delete a job while a session spawned by it is still running → session continues, `scheduled_job_id` FK is nullable
- Update `cronExpression` on a job → verify `nextRunAt` is recomputed from now
- Two jobs with the same profile and overlapping schedules → both fire independently
- Daemon down for 30 days, 5 jobs overdue → exactly 5 notifications, one per job (not 150)
- `ap schedule catchup` with no pending jobs → "No jobs need catch-up."

## Rollback Plan

If the feature needs to be reverted:
1. Drop migration `038_scheduled_jobs.sql` effects — not easily reversible via SQLite
   `ALTER TABLE DROP COLUMN` (unsupported in older SQLite). Instead, create migration
   `039_revert_scheduled_jobs.sql` that drops the table and leaves the column as dead weight.
2. Remove route registration from `server.ts` — `scheduledJobManager` is optional,
   so routes simply won't register if the dep is absent.
3. Desktop app can be reverted by removing the `ScheduledJobStore` and nav entry.

## Performance Considerations

- The scheduler runs a DB query every 60s against a small table (scheduled jobs count
  in the dozens at most). No performance concern.
- The `countActiveSessionsForJob` query uses the `idx_sessions_scheduled_job` index.
- `ScheduledJobCatchupRequestedEvent` is emitted per-job on startup; if there are 20
  overdue jobs on startup, 20 events are emitted. Desktop app batches WebSocket events
  with a 100ms flush — this is fine.
