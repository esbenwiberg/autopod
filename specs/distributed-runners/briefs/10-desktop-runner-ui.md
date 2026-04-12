# Brief 10: Desktop — runner management UI

## Objective

Add a Runners pane to the macOS desktop app: list registered runners with
status, issue enrollment tokens, revoke runners.

## Dependencies

Brief 02 (runner APIs exposed).

## Blocked By

Brief 02.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/desktop/Autopod/Views/RunnersView.swift` | create | SwiftUI list of runners with status, last seen, capabilities |
| `packages/desktop/Autopod/Views/RunnerDetailView.swift` | create | Per-runner detail: capabilities, credential fingerprint, revoke button |
| `packages/desktop/Autopod/Views/AddRunnerSheet.swift` | create | Form: display name, runner id slug, submit → shows enrollment token copyable |
| `packages/desktop/Autopod/Models/Runner.swift` | create | Codable model matching the daemon's `RunnerRecord` |
| `packages/desktop/Autopod/Services/RunnersAPI.swift` | create | `list()`, `createEnrollment(...)`, `revoke(id)` against the daemon |
| `packages/desktop/Autopod/AppContent.swift` | modify | Add Runners tab / sidebar entry (shared file — append a nav item) |

## Interface Contracts

Consumes daemon endpoints:
- `GET /api/runners` → `RunnerRecord[]`
- `POST /api/runners/enrollments` → `{ enrollmentToken, runnerId, expiresAt }`
- `DELETE /api/runners/:id`

## Implementation Notes

- Follow existing patterns from `SessionsView.swift` and `ProfilesView.swift`
  (refresh cadence, error presentation, loading states).
- WebSocket event integration: if the desktop already consumes the daemon
  events WS, subscribe to `runner.online` / `runner.offline` events for
  live status. If not, poll `/api/runners` on a 5s timer while the pane is
  visible.
- Enrollment token UI: show once, copyable with a clear "this is shown
  once — you can't retrieve it later" warning. Also include a one-click
  "copy runner setup command" that formats:
  `autopod-runner register --daemon <url> --token <token> --id <id> --name "<name>"`
- Revoke: confirmation dialog warning that in-flight sessions on that
  runner will be killed.
- `GET /api/runners` needs to exist — add to Brief 02 contracts if missing.
  (Add now: simple list endpoint beside the existing runner routes.)

## Acceptance Criteria

- [ ] Runners pane appears in the desktop app.
- [ ] Lists all registered runners with status + last seen.
- [ ] "Add runner" flow produces an enrollment token + copy-able setup
  command.
- [ ] Enrollment token is only displayed once.
- [ ] Revoke flow deletes the runner and surfaces any impacted sessions.
- [ ] Online/offline status updates live (WS) or within 5s (poll).
- [ ] Manual smoke: follow validation scenario 10 end to end.

## Estimated Scope

Files: 5 created + 1 modified | Complexity: medium
