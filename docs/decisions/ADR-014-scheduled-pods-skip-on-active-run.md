# ADR 003: Skip New Fire If Previous Run Is Still Active

## Context

A scheduled job fires at T+0, spawning a session. That session is still running
at T+24h (e.g., a complex fix session) when the job fires again.

## Decision

**Skip the new fire** if any non-terminal session tied to this job exists:

```sql
SELECT COUNT(*) FROM sessions
WHERE scheduled_job_id = ? AND status NOT IN ('complete', 'failed', 'killed')
```

If count > 0: do not fire. Advance `next_run_at` normally so the job stays on schedule.

For catch-up fires (user clicks Run in desktop notification): return HTTP 400 with
`{ error: "Previous run still active — wait for it to complete before catching up." }`

## Consequences

**Good:**
- No two sessions from the same job run in parallel on the same branch
- Safe for PR-mode jobs (no two sessions competing to push the same branch)
- Simple rule — easy to reason about

**Bad:**
- A very long-running session could cause a job to skip many fires. This is observable
  via `GET /scheduled-jobs` (user can see `lastRunAt` is stale) and the session list.
  If it becomes a pain point, a "max active run age" config could be added later.

## Alternatives Rejected

**Allow parallel runs:** Fine for read-only jobs (vuln scan) but dangerous for PR-mode
jobs. Since the job's output mode is determined by its profile (not the job itself),
we can't easily distinguish safe-to-parallelize from unsafe at fire time.

**Kill the previous run and fire a new one:** Too aggressive. The user may have been
watching the previous session. Unexpected kills are confusing.
