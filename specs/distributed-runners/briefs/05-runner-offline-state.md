# Brief 05: Daemon — `runner_offline` state + reconciliation

## Objective

Add the `runner_offline` session state, wire the runner-registry disconnect
event to transition active sessions into it, and implement the reconcile
flow on runner reconnect.

## Dependencies

Briefs 02, 03, 04.

## Blocked By

Brief 04 (needs `placement` resolved so we know which sessions belong to a
disconnecting runner).

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/shared/src/types/session.ts` | modify | Add `'runner_offline'` to `SessionStatus` union (small append; coordinate with Brief 04's edits — Brief 04 adds placement field, this adds a status literal — non-overlapping) |
| `packages/shared/src/constants.ts` | modify | Add transitions: `running → runner_offline`, `runner_offline → running | failed | killing` |
| `packages/daemon/src/sessions/runner-reconciler.ts` | create | Pure function: given a session + container status, return next transition |
| `packages/daemon/src/sessions/runner-reconciler.test.ts` | create | Table-driven tests for reconcile cases |
| `packages/daemon/src/sessions/session-manager.ts` | modify | Subscribe to `runnerRegistry.onDisconnect` + `onConnect`; on disconnect, transition active sessions to `runner_offline`; on reconnect, run reconciler |
| `packages/daemon/src/api/routes/sessions.ts` | modify | Surface `runner_offline` in status responses (no special handling needed; just ensure not filtered out) |

## Interface Contracts

```ts
export function reconcileRunnerSession(
  session: Session,
  containerStatus: 'running' | 'stopped' | 'unknown',
): { nextStatus: SessionStatus; reason: string };
```

Rules:
- `runner_offline` + `running` → `running`, reason `runner_reconnected_container_alive`.
- `runner_offline` + `stopped` | `unknown` → `failed`, reason `runner_reconnected_container_lost`.
- Any non-`runner_offline` input → unchanged (defensive; caller shouldn't call).

## Implementation Notes

- Subscribe to the registry via hooks set up in `SessionManager` constructor
  (don't add new global state).
- On disconnect event: query active sessions by `placement.kind === 'runner' && placement.runnerId === event.runnerId`,
  transition each to `runner_offline` via
  `sessionRepository.updateStatus()` (which validates transitions).
- On reconnect event: for each session in `runner_offline` for that
  runnerId, fetch `getStatus` via the new `RemoteContainerManager` (same
  path as normal ops). Then apply the reconcile result.
- If reconcile says `failed`, cleanup network + worktree as if normal fail
  path. Reuse existing cleanup code in `session-manager.ts`.
- Emit an event on the bus with the transition reason so desktop can
  display it clearly.
- Do NOT attempt to resume the agent event stream in this brief — mark the
  session `running` and let the existing reconnect path in
  `processSession()` handle resumption via `claude_session_id`. That code
  already exists for validation retry; verify it works for the offline
  case and document in a code comment.
- Kill-during-offline: `runner_offline → killing` works by the normal kill
  path, but without a live runner connection the container kill has to
  queue until reconnect OR the runner is deleted. Simpler rule: killing an
  offline session just transitions state + marks the session killed
  locally; next reconnect, daemon tells runner to clean up.

## Acceptance Criteria

- [ ] `runner_offline` added to `SessionStatus` with correct transitions.
- [ ] Unit test: runner disconnect → session transitions to `runner_offline`.
- [ ] Unit test: reconnect with container `running` → session resumes.
- [ ] Unit test: reconnect with container `stopped` → session `failed`.
- [ ] Unit test: user kills while runner offline → session enters `killing`,
  runner informed on next reconnect.
- [ ] Integration test: disconnect mid-session, reconnect, verify state
  transitions + emitted events.
- [ ] Reconciler is pure (no side effects) — enforced by test.
- [ ] Desktop emits events on disconnect + reconnect reason.

## Estimated Scope

Files: 3 modified + 2 created | Complexity: medium
