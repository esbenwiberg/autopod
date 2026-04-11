# Autopod Desktop — Architecture Reference

macOS native app (Swift/Xcode, macOS 15+) for monitoring and managing Autopod sessions. Built with SwiftUI, swift-concurrency, and the SwiftTerm terminal emulator.

---

## SPM Target Structure

```
Package.swift (AutopodDesktop)
  ├── AutopodUI        (library)     — SwiftUI views, display models, previews
  ├── AutopodClient    (library)     — REST client, WebSocket, Codable API types
  ├── AutopodDesktop   (library)     — @Observable stores, app wiring, scene config
  └── AutopodDesktopExe (executable) — @main entry point; depends on all three libraries

External dependency: SwiftTerm (terminal emulator embedded in session detail view)

Test target: AutopodClientTests — depends on AutopodClient, AutopodUI, AutopodDesktop
```

**AutopodUI** stays preview-friendly — no networking, no async actors. Pure SwiftUI views that accept data via init parameters.

**AutopodClient** is testable in isolation. Owns the `DaemonAPI` actor (REST) and `EventSocket` (WebSocket). No SwiftUI imports.

**AutopodDesktop** wires client to views. `SessionStore` and `ProfileStore` are `@Observable @MainActor` classes that observe `AutopodClient` and publish state to the view layer.

**AutopodDesktopExe** is the thin `@main` struct — one file, a `WindowGroup`, a `Settings` scene.

---

## Data Flow

```
Daemon REST  ←→  DaemonAPI (actor, async/await)
                      ↓
Daemon /events WS ←→ EventSocket (reconnect + replay)
                      ↓
               SessionStore (@Observable, @MainActor)
                      ↓
               SwiftUI Views (automatic re-render)
```

Config (daemon URL + auth token) is persisted to `~/.autopod/config.yaml` and read at launch by `AutopodDesktopExe` before constructing the `DaemonAPI` instance.

---

## Daemon API Contract

Canonical reference for what the desktop app consumes.

### REST Endpoints

```
GET  /health                              → { status: "ok", version: string, timestamp: string }
GET  /version                             → { version: string }

GET  /sessions                            → Session[]
GET  /sessions/:id                        → Session
GET  /sessions/stats                      → { [status]: count }
POST /sessions                            → Session  (body: CreateSessionRequest)
POST /sessions/:id/approve                → { ok }   (body: { squash?: bool })
POST /sessions/:id/reject                 → { ok }   (body: { feedback?: string })
POST /sessions/:id/message                → { ok }   (body: { message: string })
POST /sessions/:id/nudge                  → { ok }   (body: { message: string })
POST /sessions/:id/kill                   → { ok }
POST /sessions/:id/complete               → { ok }   (workspace pods only)
POST /sessions/:id/validate               → { ok }   (force re-validate)
POST /sessions/:id/pause                  → { ok }
DEL  /sessions/:id                        → 204
POST /sessions/approve-all                → { approved: string[] }
POST /sessions/kill-failed                → { killed: string[] }
GET  /sessions/:id/validations            → ValidationResult[]
GET  /sessions/:id/report/token           → { token, reportUrl }
GET  /sessions/:id/diff                   → { files: DiffFile[], stats: { added, removed, changed } }

GET  /profiles                            → Profile[]
GET  /profiles/:name                      → Profile
POST /profiles                            → Profile  (body: full profile)
PUT  /profiles/:name                      → Profile  (body: full profile)
DEL  /profiles/:name                      → 204
POST /profiles/:name/warm                 → { tag, digest, sizeMb, buildDuration }
```

### WebSocket — `/events?token=<token>`

Client sends:
```json
{ "type": "subscribe_all" }
{ "type": "subscribe", "sessionId": "<id>" }
{ "type": "unsubscribe", "sessionId": "<id>" }
{ "type": "replay", "lastEventId": <int> }
```

Server sends (`SystemEvent` union):
```
session.created              → { session: SessionSummary }
session.status_changed       → { sessionId, previousStatus, newStatus }
session.agent_activity       → { sessionId, event: AgentEvent }
session.validation_started   → { sessionId, attempt }
session.validation_completed → { sessionId, result: ValidationResult }
session.escalation_created   → { sessionId, escalation: EscalationRequest }
session.escalation_resolved  → { sessionId, escalationId, response }
session.completed            → { sessionId, finalStatus, summary }
```

All events include `_eventId: number` (for replay on reconnect) and `timestamp: string`.

### Auth

- REST: `Authorization: Bearer <token>` header
- WebSocket: `?token=<token>` query parameter
- Dev mode (`NODE_ENV !== 'production'`): daemon accepts any token value
