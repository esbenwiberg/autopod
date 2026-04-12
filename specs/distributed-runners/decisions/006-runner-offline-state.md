# ADR 006: Explicit `runner_offline` session state with reconciliation

## Context

A laptop runner will disconnect mid-session for predictable reasons (sleep,
Wi-Fi hop, Tailscale flake). Options for handling this:

1. **Treat disconnect as session failure.** Mark failed, user retries
   manually when they're back.
2. **Introduce a `runner_offline` state with reconcile-on-reconnect.** On
   reconnect, check if the container is still running; resume if yes, fail
   if no.
3. **Try to SIGSTOP the container before losing the connection, SIGCONT
   on reconnect.** Requires detecting imminent disconnect, which laptops
   don't support.

## Decision

**Option 2 — explicit `runner_offline` state.** Reconcile container
liveness on runner reconnect.

State transitions added:
- `running → runner_offline` when the daemon's WS drops and a session was
  active on that runner.
- `runner_offline → running` when the runner reconnects and
  `get_status(containerId) === 'running'`.
- `runner_offline → failed` when `get_status` returns `stopped` or
  `unknown` on reconnect.
- `runner_offline → killing` — user may explicitly kill during offline.

## Consequences

**Good**
- Accurately reflects the common laptop-close-lid case. Session can
  resume without user intervention after a reopen.
- Container stays alive on the runner across brief disconnects — no work
  lost during Wi-Fi hiccups.
- UI can show an explicit "runner offline — waiting for reconnect" state.

**Bad**
- New session state = state-machine additions in three places:
  `packages/shared/src/types/session.ts`,
  `packages/shared/src/constants.ts` (VALID_STATUS_TRANSITIONS), and
  runtime handling in `session-manager.ts`.
- Reconciliation logic has edge cases: container restarted with a
  different ID, runner's Docker state drifted, container exit events
  missed during partition. All need careful handling.
- A session stuck in `runner_offline` for days clutters the UI. Mitigation:
  expose a timestamp and let UI surface stale ones; user can kill.

## Alternatives

- **Fail fast** — simpler but doesn't match real-world laptop behavior;
  would mean aborting + retrying every time the user closes the lid. Bad
  UX for the primary target workflow.
- **SIGSTOP/SIGCONT** — relies on predicting disconnect. Fairy-tale
  engineering; laptops don't warn before Wi-Fi drops.
