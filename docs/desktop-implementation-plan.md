# Autopod Desktop — Architecture Reference

macOS native app (Swift/Xcode, macOS 15+) for monitoring and managing Autopod pods. Built with SwiftUI, swift-concurrency, and the SwiftTerm terminal emulator.

---

## SPM Target Structure

```
Package.swift (AutopodDesktop)
  ├── AutopodUI        (library)     — SwiftUI views, display models, previews
  ├── AutopodClient    (library)     — REST client, WebSocket, Codable API types
  ├── AutopodDesktop   (library)     — @Observable stores, app wiring, scene config
  └── AutopodDesktopExe (executable) — @main entry point; depends on all three libraries

External dependencies:
- SwiftTerm (terminal emulator embedded in pod detail view)
- MarkdownUI (renders markdown task/detail content)

Test targets:
- AutopodClientTests — depends on AutopodClient, AutopodUI, AutopodDesktop
- AutopodUITests — depends on AutopodUI, AutopodClient
```

**AutopodUI** stays preview-friendly — no networking, no async actors. Pure SwiftUI views that accept data via init parameters.

**AutopodClient** is testable in isolation. Owns the `DaemonAPI` actor (REST) and `EventSocket` (WebSocket). No SwiftUI imports.

**AutopodDesktop** wires client to views. `PodStore`, `ProfileStore`, and related stores are `@Observable @MainActor` classes that observe `AutopodClient` and publish state to the view layer.

**AutopodDesktopExe** is the thin `@main` struct — one file, a `WindowGroup`, a `Settings` scene.

---

## Data Flow

```
Daemon REST  ←→  DaemonAPI (actor, async/await)
                      ↓
Daemon /events WS ←→ EventSocket (reconnect + replay)
                      ↓
               PodStore (@Observable, @MainActor)
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

GET  /pods                                → Pod[]
GET  /pods/:id                            → Pod
GET  /pods/stats                          → { total, byStatus }
POST /pods                                → Pod  (body: CreatePodRequest)
POST /pods/:id/approve                    → { ok }   (body: { squash?: bool })
POST /pods/:id/reject                     → { ok }   (body: { feedback?: string })
POST /pods/:id/message                    → { ok }   (body: { message: string })
POST /pods/:id/nudge                      → { ok }   (body: { message: string })
POST /pods/:id/pause                      → { ok }
POST /pods/:id/kill                       → { ok }
POST /pods/:id/complete                   → { ok }   (interactive pods)
POST /pods/:id/promote                    → { ok }   (interactive → agent driven)
POST /pods/:id/validate                   → { ok }   (force validation)
POST /pods/:id/revalidate                 → RevalidateResponse
POST /pods/:id/interrupt-validation       → 204
POST /pods/:id/validation-overrides       → 204
POST /pods/:id/force-approve              → { ok }
POST /pods/:id/fix-manually               → Pod
POST /pods/:id/preview                    → { previewUrl }
DEL  /pods/:id                            → 204
POST /pods/approve-all                    → PodSummary[]
POST /pods/kill-failed                    → PodSummary[]
GET  /pods/:id/validations                → StoredValidation[]
GET  /pods/:id/validations/:attempt/evidence.yaml → YAML fact evidence
GET  /pods/:id/events?limit=500           → AgentEvent[]
GET  /pods/:id/quality                    → PodQualitySignals
GET  /pods/:id/cost                       → per-pod work/rework/validation/advisory cost buckets
GET  /pods/:id/diff                       → canonical, preview, uncommitted, and per-commit diffs
GET  /pods/:id/firewall-denials           → structured restricted-egress denial evidence
GET  /pods/:id/action-audit               → action audit rows + hash-chain verification

GET  /profiles                            → Profile[]
GET  /profiles/:name                      → Profile
GET  /profiles/:name/editor               → { raw, resolved }
POST /profiles                            → Profile  (body: full profile)
PUT  /profiles/:name                      → Profile  (body: full profile)
DEL  /profiles/:name                      → 204
POST /profiles/:name/warm                 → { tag, digest, sizeMb, buildDuration }

GET  /pods/analytics/{cost|reliability|quality|safety|throughput|escalations|models|memory}
GET  /memory                              → MemoryEntry[]
POST /memory                              → MemoryEntry
GET  /memory/candidates                   → MemoryCandidate[]
PATCH /memory/candidates/:id              → MemoryCandidate
GET  /memory/:id/{usage|source-evidence|stale-evidence|harmful-evidence}
GET  /scheduled-jobs                      → ScheduledJob[]
GET  /scheduled-job-templates             → ScheduledJobTemplate[]
POST /scheduled-job-templates             → ScheduledJobTemplate
PUT  /scheduled-job-templates/:id         → ScheduledJobTemplate
GET  /issue-watcher                       → WatchedIssue[]
```

### WebSocket — `/events`

Authenticate with `Authorization: Bearer <token>` for native/CLI clients. Browser
clients use `Sec-WebSocket-Protocol: autopod, autopod.bearer.<base64url-token>`
because the browser WebSocket API cannot set custom headers.

Client sends:
```json
{ "type": "subscribe_all" }
{ "type": "subscribe", "podId": "<id>" }
{ "type": "unsubscribe", "podId": "<id>" }
{ "type": "replay", "lastEventId": <int> }
```

Server sends (`SystemEvent` union):
```
pod.created                    → { pod: PodSummary }
pod.status_changed             → { podId, previousStatus, newStatus }
pod.agent_activity             → { podId, event: AgentEvent }
pod.validation_started         → { podId, attempt }
pod.validation_phase_started   → { podId, phase }
pod.validation_phase_completed → { podId, phase, phaseStatus, ...phaseResult }
pod.validation_completed       → { podId, result: ValidationResult }
pod.readiness_approved         → { podId, status, scope, summary, reason? }
pod.escalation_created         → { podId, escalation: EscalationRequest }
pod.escalation_resolved        → { podId, escalationId, response }
pod.completed                  → { podId, finalStatus, summary }
memory.suggestion_created      → { podId, memoryEntry }
memory.candidate_created       → { podId, candidate }
memory.candidate_updated       → { podId, candidate }
validation.override_queued     → { podId, override }
scheduled_job.*                → scheduled job lifecycle events
issue_watcher.*                → issue watcher lifecycle events
host.resumed                   → daemon wake/reconcile signal
pod.firewall_denied            → restricted-egress denial
```

Persisted events include `_eventId: number` (for replay on reconnect) and `timestamp: string`. Replay is capped; long-disconnected clients should refresh pod lists and use `GET /pods/:id/events?limit=N` for log backfill.

### Auth

- REST: `Authorization: Bearer <token>` header
- WebSocket: `?token=<token>` query parameter
- Dev mode (`NODE_ENV !== 'production'`): daemon accepts any token value
