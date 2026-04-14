# ADR 001: DB-Driven Polling Scheduler

## Context

We need to fire sessions on a recurring schedule. The daemon runs locally on a
developer laptop and is frequently restarted. The cron fires must survive daemon
restarts and be auditable.

Two main approaches existed:
1. In-process cron library (`node-cron`) — fires callbacks when cron expression matches
2. DB-driven poller — store `next_run_at` in DB, poll every 60s for overdue rows

## Decision

Use a **DB-driven poller** with a 60-second `setInterval` tick. Compute `next_run_at`
using `cron-parser` and store it in the `scheduled_jobs` table. On each tick:

```sql
SELECT * FROM scheduled_jobs
WHERE enabled = 1 AND catchup_pending = 0 AND next_run_at <= datetime('now')
```

`node-cron` is NOT used for execution, only `cron-parser` is used to validate
expressions and compute the next occurrence date.

## Consequences

**Good:**
- `next_run_at` is durable across restarts — the reconciler on startup can detect
  any rows where `next_run_at < now()` and mark them `catchup_pending`
- Single source of truth for "when does this fire next" — visible in `GET /scheduled-jobs`
- Simple to reason about: no timer state, no in-memory cron tables
- Consistent with existing patterns (`mergePollers`, `commitPollers` use setInterval too)

**Bad:**
- ±60s jitter on fire time — acceptable for these use cases (no sub-minute scheduling)
- Slightly more DB queries than a pure timer approach

## Alternatives Rejected

**`node-cron` in-process:** Fires exactly on schedule but has no persistence. If the
daemon restarts at 08:59 and the cron fires at 09:00, the timer is gone and the run
is silently missed with no recovery path.

**External scheduler (cron, GitHub Actions, Lambda):** Requires out-of-band infrastructure
the user doesn't have. Defeats the "runs locally from laptop" requirement.
