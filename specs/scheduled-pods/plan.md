# Plan: Scheduled Pods

## Problem

All sessions in autopod are demand-driven — a human or CI system calls `POST /sessions`
to start one. There's no way to say "run this task every Monday at 9am" without an
external cron job hammering the API.

Use cases that need recurring runs:
- Weekly vulnerability scan against dependencies
- Daily production log review + auto-fix
- Scheduled code review of the past week's merged PRs

## Goals

1. A first-class `scheduled_jobs` entity: cron expression, profile, task, enabled flag
2. In-process DB-driven scheduler: 60-second polling loop, no external cron daemon
3. Missed-run detection on startup: one catch-up prompt per overdue job (not per missed fire)
4. Desktop-first notification: macOS notification with Run/Skip actions; CLI as backup
5. Full CRUD via REST API, CLI (`ap schedule ...`), and desktop UI
6. Sessions spawned by scheduled jobs are linked back via `scheduled_job_id` FK

## Architecture

```
daemon/index.ts
  └─ ScheduledJobScheduler (new)
       ├─ setInterval(tick, 60_000) — fire overdue jobs
       ├─ startup reconciler — detect missed jobs → set catchup_pending
       └─ ScheduledJobManager (new)
             ├─ ScheduledJobRepository (new) ← SQLite
             └─ SessionManager.createSession() — spawn sessions
```

### Scheduler Loop (60-second tick)

```
SELECT * FROM scheduled_jobs
WHERE enabled = 1 AND catchup_pending = 0 AND next_run_at <= datetime('now')
```

For each result:
1. Check if any non-terminal session linked to this job exists → if yes, skip this fire
2. Call `sessionManager.createSession({ ..., scheduledJobId: job.id })`
3. Update `last_run_at = now()`, `last_session_id = newSession.id`,
   `next_run_at = computeNext(cronExpression)`
4. Emit `scheduled_job.fired` event

### Startup Reconciler

Run once after migrations, before the scheduler loop starts:

```
SELECT * FROM scheduled_jobs
WHERE enabled = 1 AND catchup_pending = 0 AND next_run_at < datetime('now')
```

For each overdue job:
1. Set `catchup_pending = 1`
2. Emit `scheduled_job.catchup_requested` event

### Catch-up Flow

User receives desktop notification → clicks Run or Skip:

- **Run** → `POST /scheduled-jobs/:id/catchup`
  → `createSession(...)`, set `catchup_pending = 0`, advance `next_run_at`
- **Skip** → `DELETE /scheduled-jobs/:id/catchup`
  → set `catchup_pending = 0`, advance `next_run_at`

`next_run_at` is always computed from `now()` using the cron expression — not from the
original missed fire time. A job missed by 14 days doesn't backfill 14 runs.

### Skip-if-Active Logic

Before firing (both scheduled and catch-up runs), check:
```sql
SELECT COUNT(*) FROM sessions
WHERE scheduled_job_id = ? AND status NOT IN ('complete','failed','killed','killed')
```
If count > 0: skip this fire entirely (catch-up: leave `catchup_pending = 1`, retry
on next scheduler tick or next daemon start).

## Dependencies

- `cron-parser` npm package (daemon) — validate cron expressions and compute next
  occurrence. Lightweight, no execution model. Add to `packages/daemon/package.json`.
- No changes to Docker, ACI, or validation subsystems.

## Dependency Graph of Briefs

```
01-shared-types
    ↓
02-db-and-repository ──→ 03-scheduler-manager ──→ 04-api-routes ──→ 05-cli-client
    ↓
06-desktop-app  (can start after 01 + 04)
```

## Key Risks

| Risk | Mitigation |
|------|-----------|
| Daemon restarts during catchup prompt window | `catchup_pending` persists in DB; re-emitted on next startup |
| Multiple daemon instances (not current but possible) | `catchup_pending` flag + skip-if-active prevents double-fires; acceptable for now |
| cron expression with sub-minute resolution | Reject at create time — only standard 5-field cron (no seconds) |
| Job deleted while a session it spawned is still running | FK is nullable; session continues unaffected, job is gone |
