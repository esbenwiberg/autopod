# ADR 002: One Catch-Up Prompt Per Job (Not Per Missed Fire)

## Context

When the daemon starts after a period of downtime, some scheduled jobs will have
missed one or more fires. We need to decide how many prompts to show the user.

Example: daily "check prod logs" job, daemon down for 10 days → 10 missed fires.

## Decision

Show **one catch-up prompt per job**, regardless of how many fires were missed.
The prompt says "this job was last run X days ago — run now?" not "you missed 10 runs".

If the user accepts, one session is created and `next_run_at` advances from `now()`
using the cron expression. No attempt is made to replay missed runs.

## Consequences

**Good:**
- No notification flood on startup after extended downtime
- "Check prod logs from 10 days ago" is useless — one current run is what you want
- Simpler DB model: `catchup_pending BOOLEAN` is sufficient, no missed-run counter

**Bad:**
- If you genuinely wanted every run (e.g., append-only audit log), you lose history.
  Not a current use case; can be revisited if needed.

## Alternatives Rejected

**One prompt per missed fire:** Correct in theory, unusable in practice. 14 days down
= 14 notifications. Users dismiss all of them. The feature feels broken.

**Auto-fire all missed runs on startup:** Dangerous — could spawn dozens of sessions
unexpectedly, hit concurrency limits, consume token budget, open many PRs. Requires
explicit user consent.
