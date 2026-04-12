# ADR 005: Targets never auto-reroute — queue when offline

## Context

If a profile's placement target (e.g. `runner:laptop-ewi`) is offline when a
session is created or dequeued, possible behaviors:

1. Fail the session with "target offline."
2. Queue until target returns.
3. Auto-spill to a fallback (e.g. ACI) after N minutes.
4. Per-profile policy selecting among the above.

## Decision

**Queue indefinitely** (option 2). Placement targets are never
auto-rerouted. Users can manually retarget a queued session via the
existing session API.

## Consequences

**Good**
- Matches user intent — placement is deliberate (heavy repo → laptop on
  purpose; scheduled job → ACI on purpose). Surprise rerouting would silently
  execute on the wrong hardware, likely wasting money (ACI billed per minute)
  or time (wrong CPU class).
- Simpler scheduler — no fallback chains, no timeouts, no priority rules.
- Trivial to reason about. Session is where you asked it to be, full stop.

**Bad**
- Session sits in `queued` with no progress when runner is offline for
  days. Mitigated by desktop UI showing clearly "target X is offline."
- If user forgets a session was queued and never brings runner back, it
  just sits. Acceptable — queue is visible + killable in the UI.

## Alternatives

- **Auto-spill to ACI after N minutes.** User explicitly rejected this
  (see conversation): placement should stick because they already pick it
  based on schedule / repo size.
- **Fail fast.** Loses the "my laptop's waking up in 15 min, just wait"
  use case without adding anything the user can't do themselves (they
  can cancel + retarget if they actually want to change).
- **Per-profile policy (option 4).** Over-engineered for v1. Can be added
  later without breaking changes if a real use case appears.
