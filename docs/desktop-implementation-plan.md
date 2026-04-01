# Autopod Desktop — Implementation Plan

> Target audience: Claude Code (autonomous execution). Each slice is a self-contained unit of work
> with exact file paths, type signatures, and build-validation commands.

## Current State

The `packages/desktop/` directory contains a **prototype UI package** (`AutopodUI`) with:

- 21 Swift files across Models/ and Views/ — all rendering with mock data
- SwiftUI previews working, `swift build` succeeds
- **No networking, no stores, no app target** — just a library of view components
- Package.swift defines a single library target (`AutopodUI`, swift-tools-version 6.0, macOS 15)

### What exists and is reusable

| File | Status | Notes |
|------|--------|-------|
| `Models/Session.swift` | **Adapt** | Good enum/struct design, needs `Codable` + mapping from API response |
| `Models/Profile.swift` | **Adapt** | Comprehensive, needs `Codable` + mapping |
| `Models/AgentEvent.swift` | **Adapt** | Needs `Codable`, ID should be server-assigned |
| `Models/MockData.swift` | **Keep** | Used for previews, keep as-is |
| `Models/MockEvents.swift` | **Keep** | Used for previews |
| `Views/Shell/MainView.swift` | **Heavy rewrite** | Currently wired to MockData, needs store injection |
| `Views/Shell/SidebarView.swift` | **Adapt** | Pure view, just needs data source swap |
| `Views/Cards/SessionCardFinal.swift` | **Adapt** | Well-built, needs action closures instead of empty `{}` |
| `Views/Detail/DetailPanelView.swift` | **Adapt** | Has placeholder tabs, needs real content |
| `Views/Detail/OverviewTab.swift` | **Adapt** | Needs real escalation reply wiring |
| `Views/Creation/CreateSessionSheet.swift` | **Adapt** | Needs real profile picker + API call |
| `Views/Profiles/ProfileEditorView.swift` | **Adapt** | Needs save/delete wiring to API |
| `Views/Profiles/ProfileListView.swift` | **Adapt** | Needs real data source |
| `Views/Logs/LogStreamView.swift` | **Adapt** | Needs real event source |
| `Views/Shared/StatusDot.swift` | **Keep** | Pure component, no changes needed |
| `Views/Cards/SessionCard[B,C].swift` | **Delete** | Earlier iterations, superseded by SessionCardFinal |
| `Views/Cards/CardComparison.swift` | **Delete** | Design comparison view, not needed |
| `Views/Cards/CardFleetView.swift` | **Delete** | Superseded by MainView's card grid |

---

## Build System Strategy

**Phase 1 (now):** Pure SPM — `swift build` / `swift run` for development. All code is text files
that Claude Code can create, edit, and validate. Runs fine on the developer's machine.

**Phase 2 (when sharing):** Add an Xcode project wrapper around the SPM packages. The `.xcodeproj`
provides: code signing, entitlements (Keychain, notifications), app icon, Info.plist, notarization
for distribution. Claude Code continues to edit the `.swift` files — the Xcode project just
references them. This is a one-time 5-minute manual step, not a blocker for any slice.

**Why not Xcode from day one:** `.xcodeproj` files are XML/plist blobs that are hard to create
programmatically. SPM keeps everything in plain text. Start fast, add the app shell when needed.

---

## Target Architecture

```
Package.swift
  ├── AutopodUI        (library)  — Views + display models + previews
  ├── AutopodClient    (library)  — REST client, WebSocket, Codable response types
  └── AutopodDesktop   (executable) — @main app, stores, wiring

External dependency: SwiftTerm (added in Slice 10)
```

### Why three targets

- **AutopodUI** stays preview-friendly — no async, no networking, instant canvas
- **AutopodClient** is testable in isolation — mock URLProtocol, no SwiftUI
- **AutopodDesktop** wires everything — stores observe client, views observe stores

### Data flow

```
Daemon REST ←→ DaemonAPI (actor, async/await)
                    ↓
Daemon /events WS ←→ EventSocket (reconnect + replay)
                    ↓
              SessionStore (@Observable, @MainActor)
                    ↓
              SwiftUI Views (automatic re-render)
```

---

## Package.swift — Target State

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AutopodDesktop",
    platforms: [.macOS(.v15)],
    dependencies: [
        // Added in Slice 10:
        // .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    ],
    targets: [
        .target(
            name: "AutopodUI",
            path: "Sources/AutopodUI"
        ),
        .target(
            name: "AutopodClient",
            path: "Sources/AutopodClient"
        ),
        .executableTarget(
            name: "AutopodDesktop",
            dependencies: ["AutopodUI", "AutopodClient"],
            path: "Sources/AutopodDesktop"
        ),
        .testTarget(
            name: "AutopodClientTests",
            dependencies: ["AutopodClient"],
            path: "Tests/AutopodClientTests"
        ),
    ]
)
```

---

## Daemon API Contract

Every endpoint the desktop app will consume, mapped to Swift function signatures.

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
POST /sessions/:id/complete               → { ok }   (workspace only)
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

Server sends (SystemEvent union):
```
session.created           → { session: SessionSummary }
session.status_changed    → { sessionId, previousStatus, newStatus }
session.agent_activity    → { sessionId, event: AgentEvent }
session.validation_started → { sessionId, attempt }
session.validation_completed → { sessionId, result: ValidationResult }
session.escalation_created → { sessionId, escalation: EscalationRequest }
session.escalation_resolved → { sessionId, escalationId, response }
session.completed         → { sessionId, finalStatus, summary }
```

All events include `_eventId: number` (for replay tracking) and `timestamp: string`.

### Auth

- REST: `Authorization: Bearer <token>` header
- WebSocket: `?token=<token>` query parameter
- Dev mode (`NODE_ENV !== 'production'`): accepts any token

---

## Slices

### Slice 0 — Executable App Target + Build Scaffold

**Goal:** Runnable macOS app that opens a window with the existing prototype fleet view using mock data.

**Files to create:**
```
Sources/AutopodDesktop/
  AutopodApp.swift          — @main entry, WindowGroup
Sources/AutopodClient/
  DaemonAPI.swift           — stub (empty actor, compiles)
```

**AutopodApp.swift:**
```swift
import SwiftUI
import AutopodUI

@main
struct AutopodApp: App {
    var body: some Scene {
        WindowGroup {
            MainView()
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 1200, height: 700)
    }
}
```

**DaemonAPI.swift (stub):**
```swift
import Foundation

public actor DaemonAPI {
    public let baseURL: URL
    public let token: String

    public init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
    }
}
```

**Package.swift changes:**
- Rename package from `AutopodUI` to `AutopodDesktop`
- Add `AutopodClient` library target
- Add `AutopodDesktop` executable target depending on both
- Add `AutopodClientTests` test target

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
# Should end with "Build complete!"
swift run AutopodDesktop &  # App window should open with mock fleet view
```

**Acceptance criteria:**
- `swift build` succeeds
- `swift run AutopodDesktop` launches window showing mock fleet view
- SwiftUI previews in AutopodUI still work (no regressions)

---

### Slice 1 — REST Client + Codable Response Types

**Goal:** Full REST client that can talk to a running daemon. Codable types for all API responses.

**Files to create:**
```
Sources/AutopodClient/
  DaemonAPI.swift           — full REST client (replace stub)
  DaemonError.swift         — error types
  Types/
    SessionResponse.swift   — Codable, mirrors daemon Session
    ProfileResponse.swift   — Codable, mirrors daemon Profile
    ValidationResponse.swift — Codable, mirrors daemon ValidationResult
    EventTypes.swift        — Codable, SystemEvent + AgentEvent
    CreateSessionRequest.swift — Encodable request body
```

**DaemonAPI interface (full):**
```swift
public actor DaemonAPI {
    // Connection
    public func healthCheck() async throws -> Bool

    // Sessions
    public func listSessions(profileName: String?, status: String?) async throws -> [SessionResponse]
    public func getSession(_ id: String) async throws -> SessionResponse
    public func getSessionStats(profileName: String?) async throws -> [String: Int]
    public func createSession(_ request: CreateSessionRequest) async throws -> SessionResponse
    public func approveSession(_ id: String, squash: Bool?) async throws
    public func rejectSession(_ id: String, feedback: String?) async throws
    public func sendMessage(_ id: String, message: String) async throws
    public func nudgeSession(_ id: String, message: String) async throws
    public func killSession(_ id: String) async throws
    public func completeSession(_ id: String) async throws
    public func triggerValidation(_ id: String) async throws
    public func pauseSession(_ id: String) async throws
    public func deleteSession(_ id: String) async throws
    public func approveAllValidated() async throws -> [String]
    public func killAllFailed() async throws -> [String]
    public func getValidationHistory(_ id: String) async throws -> [ValidationResponse]
    public func getReportToken(_ id: String) async throws -> (token: String?, reportUrl: String)

    // Profiles
    public func listProfiles() async throws -> [ProfileResponse]
    public func getProfile(_ name: String) async throws -> ProfileResponse
    public func createProfile(_ body: ProfileResponse) async throws -> ProfileResponse
    public func updateProfile(_ name: String, body: ProfileResponse) async throws -> ProfileResponse
    public func deleteProfile(_ name: String) async throws
    public func warmProfile(_ name: String, rebuild: Bool?, gitPat: String?) async throws -> WarmResult
}
```

**DaemonError:**
```swift
public enum DaemonError: Error, LocalizedError {
    case unauthorized
    case notFound(String)
    case badRequest(String)
    case serverError(Int, String)
    case networkError(Error)
    case decodingError(Error)
}
```

**SessionResponse (key fields):**
```swift
public struct SessionResponse: Codable, Sendable {
    public let id: String
    public let profileName: String
    public let task: String
    public let status: String  // raw string, mapped to enum in UI layer
    public let model: String
    public let runtime: String
    public let executionTarget: String
    public let branch: String
    public let containerId: String?
    public let worktreePath: String?
    public let validationAttempts: Int
    public let maxValidationAttempts: Int
    public let lastValidationResult: ValidationResponse?
    public let pendingEscalation: EscalationResponse?
    public let escalationCount: Int
    public let skipValidation: Bool
    public let createdAt: String
    public let startedAt: String?
    public let completedAt: String?
    public let updatedAt: String
    public let userId: String
    public let filesChanged: Int
    public let linesAdded: Int
    public let linesRemoved: Int
    public let previewUrl: String?
    public let prUrl: String?
    public let plan: PlanResponse?
    public let progress: ProgressResponse?
    public let acceptanceCriteria: [String]?
    public let claudeSessionId: String?
    public let outputMode: String
    public let baseBranch: String?
    public let acFrom: String?
    public let inputTokens: Int
    public let outputTokens: Int
    public let costUsd: Double
    public let commitCount: Int
    public let lastCommitAt: String?
}
```

**Implementation pattern for all REST calls:**
```swift
private func request<T: Decodable>(
    method: String,
    path: String,
    body: (any Encodable)? = nil
) async throws -> T {
    var req = URLRequest(url: baseURL.appendingPathComponent(path))
    req.httpMethod = method
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let body {
        req.httpBody = try JSONEncoder().encode(body)
    }
    let (data, response) = try await URLSession.shared.data(for: req)
    guard let http = response as? HTTPURLResponse else {
        throw DaemonError.networkError(URLError(.badServerResponse))
    }
    switch http.statusCode {
    case 200...201: return try JSONDecoder().decode(T.self, from: data)
    case 204: return EmptyResponse() as! T  // for void endpoints
    case 401: throw DaemonError.unauthorized
    case 404: throw DaemonError.notFound(path)
    case 400: throw DaemonError.badRequest(String(data: data, encoding: .utf8) ?? "")
    default: throw DaemonError.serverError(http.statusCode, String(data: data, encoding: .utf8) ?? "")
    }
}
```

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
```

**Acceptance criteria:**
- All response types compile with `Codable`
- DaemonAPI has methods for every endpoint in the contract
- `swift build` succeeds
- Types match the daemon JSON shape (verified by reading daemon source)

---

### Slice 2 — Connection Manager + Setup Sheet

**Goal:** App connects to a daemon, persists connection config, shows connection status.

**Files to create:**
```
Sources/AutopodDesktop/
  Stores/
    ConnectionManager.swift   — @Observable, health polling, reconnect
  Views/
    SetupSheet.swift          — first-launch "Add Daemon" form
Sources/AutopodClient/
  KeychainHelper.swift        — token storage in macOS Keychain
  DaemonConnection.swift      — URL + token + name, Codable for UserDefaults
```

**ConnectionManager:**
```swift
@Observable
@MainActor
public final class ConnectionManager {
    enum State: Equatable {
        case disconnected
        case connecting
        case connected
        case error(String)
    }

    var state: State = .disconnected
    var connection: DaemonConnection?
    var api: DaemonAPI?

    var isConnected: Bool { state == .connected }

    func connect(to connection: DaemonConnection) async { ... }
    func disconnect() { ... }
    func startHealthPolling(interval: TimeInterval = 30) { ... }
}
```

**DaemonConnection:**
```swift
public struct DaemonConnection: Codable, Sendable {
    public var id: UUID
    public var name: String
    public var url: URL
    // Token stored separately in Keychain, keyed by id
}
```

**Changes to existing files:**
- `AutopodApp.swift` — inject `ConnectionManager` into environment, show SetupSheet when no connection
- `SidebarView.swift` — update connection header to use real state from `ConnectionManager`
- `MainView.swift` — accept `ConnectionManager` from environment

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
# Manual: run app with daemon running on localhost:3000 — green dot should appear
# Manual: run app with daemon stopped — should show error state, then reconnect when daemon starts
```

**Acceptance criteria:**
- App launches, shows SetupSheet if no saved connection
- Enter URL + token, test connection (calls `/health`), saves on success
- Token stored in Keychain, connection metadata in UserDefaults
- Green dot in sidebar when connected, red + message when not
- Auto-reconnect with health polling every 30s

---

### Slice 3 — Live Sessions (REST → Store → Views)

**Goal:** Replace mock data with real sessions from the daemon.

**Files to create:**
```
Sources/AutopodDesktop/
  Stores/
    SessionStore.swift        — @Observable, manages session state
  Mapping/
    SessionMapper.swift       — SessionResponse → Session (UI model)
```

**SessionStore:**
```swift
@Observable
@MainActor
public final class SessionStore {
    var sessions: [Session] = []
    var selectedSession: Session?
    var isLoading = false
    var error: String?

    private let api: DaemonAPI

    func loadSessions() async { ... }
    func refreshSession(_ id: String) async { ... }

    // Computed groupings (used by sidebar badges)
    var attentionSessions: [Session] { sessions.filter { $0.status.needsAttention } }
    var runningSessions: [Session] { sessions.filter { $0.status.isActive && !$0.isWorkspace } }
    var workspaceSessions: [Session] { sessions.filter { $0.isWorkspace } }
}
```

**SessionMapper:**
Maps `SessionResponse` (Codable, string-typed) → `Session` (UI model, enum-typed). Key mappings:
- `status: String` → `SessionStatus` enum (already defined in Session.swift)
- `outputMode: String` → `OutputMode` enum
- `filesChanged/linesAdded/linesRemoved` → `DiffStats`
- `progress` → `PhaseProgress`
- `pendingEscalation?.payload.question` → `escalationQuestion: String?`
- `lastValidationResult` → `ValidationChecks`
- `validationAttempts/maxValidationAttempts` → `AttemptInfo`
- `createdAt: String` → `startedAt: Date` (ISO8601 parse)

**Changes to Session.swift (AutopodUI):**
- Session `id` changes from `UUID` to `String` (daemon uses string IDs like `feat-oauth-a1b2`)
- Add `task: String` field (the session's task description, missing from current model)
- Add `paused` case to `SessionStatus` enum (exists in daemon but missing from prototype)
- Add `inputTokens: Int`, `outputTokens: Int`, `costUsd: Double` for token tracking
- Add `commitCount: Int` for commit tracking

**Changes to MainView.swift:**
- Remove `private let sessions = MockData.all`
- Accept `SessionStore` from environment
- Use `sessionStore.sessions` for rendering, `sessionStore.selectedSession` for detail
- Show loading spinner on initial load
- Show empty state when no sessions

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
# Manual: start daemon with test sessions, verify they appear in the app
```

**Acceptance criteria:**
- App shows real sessions from daemon on launch
- All 12 session states render correctly with real data
- Sidebar badge counts reflect real session counts
- Empty state renders when no sessions exist
- Session detail panel shows real data when session selected
- Pull-to-refresh or manual refresh button reloads sessions

---

### Slice 4 — Real-time Event Stream

**Goal:** Sessions update live via WebSocket, no polling needed.

**Files to create:**
```
Sources/AutopodClient/
  EventSocket.swift           — WebSocket client with reconnect + replay
Sources/AutopodDesktop/
  Stores/
    EventStream.swift         — bridges EventSocket → SessionStore updates
```

**EventSocket:**
```swift
public actor EventSocket {
    public enum State: Sendable {
        case disconnected
        case connecting
        case connected
        case reconnecting(attempt: Int)
    }

    private var webSocketTask: URLSessionWebSocketTask?
    private var lastEventId: Int = 0
    private let url: URL      // ws://host:port/events?token=xxx
    private let onEvent: @Sendable (SystemEvent) -> Void
    private let onStateChange: @Sendable (State) -> Void

    public init(url: URL, onEvent: ..., onStateChange: ...)
    public func connect() async
    public func disconnect()
    public func subscribeAll() async
    public func subscribe(sessionId: String) async
    public func unsubscribe(sessionId: String) async

    // Internal: exponential backoff reconnect 1s → 2s → 4s → 8s → 16s cap
    // Internal: on reconnect, send replay with lastEventId
    // Internal: monitor heartbeat (expect ping every 30s)
}
```

**EventStream:**
```swift
@Observable
@MainActor
public final class EventStream {
    var connectionState: EventSocket.State = .disconnected
    var recentEvents: [AgentEvent] = []  // Global event buffer (capped at 500)

    private var eventSocket: EventSocket?
    private let sessionStore: SessionStore

    func connect(url: URL) { ... }
    func disconnect() { ... }

    // Dispatch incoming events to SessionStore
    private func handleEvent(_ event: SystemEvent) {
        switch event.type {
        case "session.created":
            // Add new session to store
        case "session.status_changed":
            // Update session status in store
        case "session.agent_activity":
            // Update latest activity, phase, diff stats, tool counts
        case "session.escalation_created":
            // Set escalation question on session
        case "session.escalation_resolved":
            // Clear escalation on session
        case "session.validation_completed":
            // Set validation result on session
        case "session.completed":
            // Mark session complete, set PR URL
        }
    }
}
```

**Changes to existing files:**
- `AutopodApp.swift` — create EventStream, connect on launch, disconnect on quit
- `SidebarView.swift` — show WebSocket connection state indicator

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
# Manual: create a session via CLI while app is open — card should appear in real-time
# Manual: kill daemon, verify reconnect indicator, restart daemon, verify events resume
```

**Acceptance criteria:**
- Session cards update in real-time as agent works
- New sessions appear without manual refresh
- Progress bar advances as phases change
- Escalation card appears instantly when agent asks a question
- Validation results appear when validation completes
- WebSocket reconnects automatically after brief disconnects
- Event replay catches up missed events on reconnect (no data loss)
- Connection state indicator shows reconnecting state

---

### Slice 5 — Session Actions

**Goal:** All action buttons work against the real daemon API.

**Files to create:**
```
Sources/AutopodDesktop/
  Stores/
    ActionHandler.swift       — executes session actions, optimistic updates
```

**ActionHandler:**
```swift
@Observable
@MainActor
public final class ActionHandler {
    var pendingAction: String?  // For loading indicators
    var lastError: String?

    private let api: DaemonAPI
    private let sessionStore: SessionStore

    func approve(_ sessionId: String, squash: Bool = false) async { ... }
    func reject(_ sessionId: String, feedback: String?) async { ... }
    func reply(_ sessionId: String, message: String) async { ... }
    func nudge(_ sessionId: String, message: String) async { ... }
    func kill(_ sessionId: String) async { ... }
    func complete(_ sessionId: String) async { ... }  // workspace
    func retry(_ sessionId: String) async { ... }     // kill + recreate
    func pause(_ sessionId: String) async { ... }
    func createSession(_ request: CreateSessionRequest) async throws -> String { ... }
    func approveAllValidated() async { ... }
    func killAllFailed() async { ... }
    func deleteSession(_ sessionId: String) async { ... }
}
```

**Optimistic update pattern:**
```swift
func approve(_ sessionId: String, squash: Bool = false) async {
    // 1. Optimistic: update local state immediately
    sessionStore.updateStatus(sessionId, to: .approved)
    pendingAction = "approve-\(sessionId)"

    // 2. Call API
    do {
        try await api.approveSession(sessionId, squash: squash)
    } catch {
        // 3. Rollback on failure
        sessionStore.updateStatus(sessionId, to: .validated)
        lastError = error.localizedDescription
    }

    pendingAction = nil
}
```

**Changes to existing views:**
- `SessionCardFinal.swift` — wire all empty `Button {}` closures to ActionHandler
- `DetailPanelView.swift` — wire header action buttons
- `OverviewTab.swift` — wire escalation reply (real TextField binding + send)
- `CreateSessionSheet.swift` — wire to `actionHandler.createSession()`
- `MainView.swift` — inject ActionHandler, show error alerts

**Key interactions:**
- Approve: calls `POST /sessions/:id/approve`, updates card to "approved"
- Reject: shows confirmation dialog with optional feedback field, calls `POST /sessions/:id/reject`
- Reply: sends `POST /sessions/:id/message` with typed response text
- Nudge: sends `POST /sessions/:id/nudge` with "Please refocus on the task"
- Kill: shows confirmation dialog, calls `POST /sessions/:id/kill`
- Create session: fills CreateSessionRequest from sheet fields, calls `POST /sessions`

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
# Manual: approve a validated session — should transition to approved
# Manual: reply to escalation — escalation card should disappear
# Manual: create session from sheet — should appear in fleet view
```

**Acceptance criteria:**
- All action buttons work against real daemon
- Optimistic UI updates (immediate state change, rollback on error)
- Escalation reply clears the card and sends real message
- Create session sheet creates a real session
- Kill shows confirmation dialog
- Errors display as `.alert()` overlays
- Loading state shown during API calls (disable button, show spinner)

---

### Slice 6 — Profiles (CRUD)

**Goal:** Full profile management — list, create, edit, delete.

**Files to create:**
```
Sources/AutopodDesktop/
  Stores/
    ProfileStore.swift        — @Observable, profile CRUD
  Mapping/
    ProfileMapper.swift       — ProfileResponse ↔ Profile (UI model)
```

**ProfileStore:**
```swift
@Observable
@MainActor
public final class ProfileStore {
    var profiles: [Profile] = []
    var isLoading = false
    var error: String?

    private let api: DaemonAPI

    func loadProfiles() async { ... }
    func createProfile(_ profile: Profile) async throws { ... }
    func updateProfile(_ name: String, _ profile: Profile) async throws { ... }
    func deleteProfile(_ name: String) async throws { ... }
    func warmProfile(_ name: String) async throws -> WarmResult { ... }
}
```

**ProfileMapper:**
Maps `ProfileResponse` → `Profile` (UI model). Key mappings:
- `networkPolicy` → `networkEnabled`, `networkMode`, `allowedHosts`
- `githubPat != null` → `hasGithubPat: true` (don't expose actual token)
- `adoPat != null` → `hasAdoPat: true`
- `mcpServers.count` → `mcpServerCount`
- Reverse mapping for create/update (Profile → request body)

**Changes to existing views:**
- `ProfileListView.swift` — use `ProfileStore.profiles`, wire edit/delete actions
- `ProfileEditorView.swift` — wire Save/Delete/Cancel to ProfileStore methods
- `CreateSessionSheet.swift` — use `ProfileStore.profiles` for picker instead of hardcoded list
- `SidebarView.swift` — use `ProfileStore.profiles` for profile section

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
# Manual: profile list shows real profiles
# Manual: create profile, verify it appears
# Manual: edit profile, save, verify changes persist
```

**Acceptance criteria:**
- Profile list shows real profiles from daemon
- Create new profile with all fields
- Edit existing profile
- Delete profile with confirmation dialog
- Session creation sheet populates profile picker from real data
- Sidebar profile section shows real profiles with session counts

---

### Slice 7 — Live Logs + Per-Session Events

**Goal:** Log stream view shows real agent events for the selected session.

**Changes to EventStream:**
- Track per-session event buffers: `sessionEvents: [String: [AgentEvent]]` (keyed by session ID)
- When detail panel opens for a session, call `eventSocket.subscribe(sessionId:)`
- When navigating away, call `eventSocket.unsubscribe(sessionId:)`
- Cap per-session buffer at 1000 events (evict oldest)
- Load historical events via `GET /sessions/:id/validations` for completed sessions (events are embedded in validation results)

**Changes to existing views:**
- `DetailPanelView.swift` — subscribe to session events when panel opens, unsubscribe on disappear
- `LogStreamView.swift` — use real events from EventStream instead of MockEvents
- `OverviewTab.swift` — use real events for activity feed and metrics

**Note:** The daemon does not have a dedicated `GET /sessions/:id/events` endpoint. Agent events flow exclusively through the WebSocket. For sessions that were already running when the app connected, the event history will be partial (only events received since connection). This is acceptable — the agent's latest activity, progress, and diff stats are on the Session object from REST.

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
# Manual: open detail panel for running session — events should stream in
# Manual: filter events by type — should filter correctly
# Manual: navigate away and back — should not leak subscriptions
```

**Acceptance criteria:**
- Real agent events stream into log view as agent works
- Filter pills work on real event types (status, tool, file, escalation, etc.)
- Auto-scroll follows new events with "pin to bottom" toggle
- Metrics row (tool calls, duration, etc.) reflects real event data
- Activity feed shows latest events
- Navigating away unsubscribes cleanly (no memory leaks)

---

### Slice 8 — Menubar + Notifications

**Goal:** Always-visible menubar tray + native macOS notifications.

**Files to create:**
```
Sources/AutopodDesktop/
  Views/
    MenuBarView.swift         — MenuBarExtra content
  Services/
    NotificationService.swift — UNUserNotificationCenter wrapper
```

**Changes to AutopodApp.swift:**
```swift
@main
struct AutopodApp: App {
    var body: some Scene {
        WindowGroup { ... }

        MenuBarExtra {
            MenuBarView(sessionStore: sessionStore)
        } label: {
            Label {
                Text("Autopod")
            } icon: {
                Image(systemName: attentionCount > 0 ? "circle.fill" : "circle")
            }
        }
        .menuBarExtraStyle(.window)
    }
}
```

**MenuBarView:**
- Shows attention count badge
- Lists sessions needing attention (truncated to 5)
- Quick actions: "Open Dashboard", "New Session", "Approve All Validated"
- Connection status indicator

**NotificationService:**
```swift
@MainActor
final class NotificationService: NSObject, UNUserNotificationCenterDelegate {
    func requestPermission() async { ... }
    func notifyEscalation(session: Session, question: String) { ... }
    func notifyValidationComplete(session: Session, passed: Bool) { ... }
    func notifySessionFailed(session: Session, error: String) { ... }
    func notifySessionComplete(session: Session, prUrl: URL?) { ... }
}
```

Wire to EventStream — emit notifications on relevant events. Add user preference toggles for each notification type (stored in UserDefaults).

**Actionable notifications:**
- Validation complete → "Approve" action button (calls approve API directly)
- Escalation → "View" action button (opens app to that session)

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
# Manual: menubar icon should appear with badge count
# Manual: create escalation — notification should fire
# Manual: click notification — should open app to that session
```

**Acceptance criteria:**
- Menubar icon shows attention count
- Clicking menubar shows fleet summary
- Notifications fire for: escalation, validation complete, failure, completion
- Notification actions work (approve, view)
- Notification preferences toggleable in settings

---

### Slice 9 — Command Palette

**Goal:** `Cmd+K` spotlight-style command palette.

**Files to create:**
```
Sources/AutopodDesktop/
  Views/
    CommandPalette.swift      — overlay with fuzzy search
```

**CommandPalette:**
- Floating overlay triggered by `Cmd+K` (`.keyboardShortcut("k", modifiers: .command)`)
- Text field with fuzzy search (simple substring match is fine initially)
- Results sections:
  - **Sessions**: match on branch name, profile name, status
  - **Actions**: "New Session" (⌘N), "Approve All Validated" (⌘⇧A), "Kill All Failed" (⌘⇧K)
  - **Navigation**: "Switch to Cards" (⌘2), "Switch to List" (⌘1), "Settings" (⌘,)
- Keyboard navigation: ↑/↓ arrows, Enter to execute, Esc to dismiss
- All icons use SF Symbols (no emoji)

**Global keyboard shortcuts to register:**
```swift
.keyboardShortcut("n", modifiers: .command)           // New session
.keyboardShortcut("k", modifiers: .command)           // Command palette
.keyboardShortcut("1", modifiers: .command)           // List view
.keyboardShortcut("2", modifiers: .command)           // Card view
.keyboardShortcut("a", modifiers: [.command, .shift]) // Approve all validated
```

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
# Manual: Cmd+K opens palette, type to filter, arrow keys navigate, Enter executes
```

**Acceptance criteria:**
- Cmd+K opens palette from anywhere in the app
- Fuzzy search filters sessions and actions
- Arrow keys navigate, Enter executes, Esc dismisses
- All keyboard shortcuts work

---

### Slice 10 — Validation Detail Tab

**Goal:** Validation results breakdown in the detail panel.

**Changes to DetailPanelView.swift:**
- Replace `validationPlaceholder` with real `ValidationTab` view

**Files to create:**
```
Sources/AutopodUI/Views/Detail/
  ValidationTab.swift         — validation results breakdown
```

**ValidationTab:**
- Validation attempt selector (if multiple attempts) — dropdown or segmented control
- Results breakdown sections:
  - **Smoke Tests**: build status, health check, per-page results with screenshots
  - **Test Suite**: pass/fail with stdout/stderr expandable
  - **AC Validation**: per-criterion pass/fail with reasoning and screenshots
  - **Task Review**: pass/fail/uncertain with reasoning, issues list, screenshots
- Each section expandable with chevron disclosure
- Screenshots displayed inline as `AsyncImage` from base64 data (screenshots are base64-encoded in the validation result)
- "Open Live App" button if session has `previewUrl` and container is still running

**Data source:** `SessionStore` holds validation history per session (loaded from `GET /sessions/:id/validations` when validation tab is selected).

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
# Manual: select validated session, click Validation tab — should show results
```

**Acceptance criteria:**
- Validation tab shows real results from daemon
- Multiple validation attempts navigable
- Screenshots display inline
- Expandable sections for each validation category
- "Open Live App" button works when container is running

---

### Slice 11 — Diff View

**Goal:** Syntax-highlighted diff viewer in the detail panel.

**Approach:** Uses the new `GET /sessions/:id/diff` daemon endpoint (see Daemon Changes section). This returns structured diff data for any session — running, validated, or completed. Fallback: for older sessions without the endpoint, extract diff from `TaskReviewResult.diff` field in validation results.

**Files to create:**
```
Sources/AutopodUI/Views/Detail/
  DiffTab.swift               — diff viewer
  DiffParser.swift            — unified diff → structured model
```

**DiffParser:**
```swift
struct DiffFile {
    let path: String
    let status: FileStatus  // added, modified, deleted
    let hunks: [DiffHunk]
    var linesAdded: Int
    var linesRemoved: Int
}

struct DiffHunk {
    let header: String  // @@ -x,y +a,b @@
    let lines: [DiffLine]
}

struct DiffLine {
    enum Kind { case context, added, removed }
    let kind: Kind
    let oldLineNumber: Int?
    let newLineNumber: Int?
    let content: String
}

func parseDiff(_ raw: String) -> [DiffFile]
```

**DiffTab:**
- Left sidebar: file tree showing changed files (added green, removed red, modified blue)
- Main area: unified diff with line numbers, color-coded (green for +, red for -)
- Stats header: "+X -Y lines, Z files changed"
- Click file in tree to jump to its diff
- No syntax highlighting initially (plain monospace) — can add later with a highlight library

**Validation:**
```bash
cd packages/desktop && swift build 2>&1 | tail -5
# Manual: select validated session, click Diff tab — should show file changes
```

**Acceptance criteria:**
- Diff tab shows real file changes from validation result
- File tree shows changed files with status indicators
- Added/removed lines color-coded
- Stats header shows correct counts
- Click file to navigate

---

### Slice 12 — Terminal (Requires Daemon Work)

**Goal:** Interactive terminal to running containers.

**Prerequisites:** New daemon endpoint `WS /sessions/:id/terminal` (see Daemon Changes section below).

**Dependencies to add to Package.swift:**
```swift
.package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
```

**Files to create:**
```
Sources/AutopodClient/
  TerminalSocket.swift        — WebSocket adapter for terminal I/O
Sources/AutopodUI/Views/Detail/
  TerminalTab.swift           — SwiftTerm embedded view
```

**TerminalSocket:**
```swift
public actor TerminalSocket {
    // Binary frames for stdin/stdout
    // JSON control frames for resize: { "type": "resize", "cols": N, "rows": N }
    func connect(sessionId: String, cols: Int, rows: Int) async throws
    func send(data: Data)    // stdin
    func resize(cols: Int, rows: Int)
    func disconnect()
    var onData: (@Sendable (Data) -> Void)?  // stdout callback
}
```

**TerminalTab:**
- Embeds SwiftTerm `TerminalView` (AppKit wrapper in SwiftUI via `NSViewRepresentable`)
- Auto-connects when tab is selected for running sessions
- Resize handling on window resize sends resize control frame
- Toolbar: disconnect button, clear screen button
- Shows "Container not running" placeholder for non-running sessions
- Disconnects cleanly when navigating away (`.onDisappear`)

**Acceptance criteria:**
- Terminal tab connects to running container
- Keystrokes flow to container, output renders
- Window resize sends resize control frame
- Clean disconnect on navigation
- "Container not running" for non-active sessions

---

### Slice 13 — Settings + Multi-Daemon

**Goal:** Settings panel and ability to manage multiple daemon connections.

**Files to create:**
```
Sources/AutopodDesktop/
  Views/
    SettingsView.swift        — app preferences
    ConnectionListView.swift  — manage multiple daemon connections
```

**SettingsView sections:**
- **Connections**: list of saved daemon connections, add/edit/delete, set active
- **Notifications**: toggle per notification type
- **Appearance**: follow system / force dark / force light (optional)
- **About**: version, links

**ConnectionManager changes:**
- Support multiple saved connections
- Active connection selector
- Switch between connections (disconnect old, connect new)

**Acceptance criteria:**
- Settings accessible via ⌘, or gear icon in sidebar
- Can add, edit, delete daemon connections
- Can switch between connections
- Notification preferences persist

---

## Daemon Changes Required

These are daemon-side changes needed to fully support the desktop app. They should be done in parallel with or before the relevant slices.

### 1. Terminal WebSocket Endpoint (blocks Slice 12)

New file: `packages/daemon/src/api/routes/terminal.ts`

```
WS /sessions/:sessionId/terminal
  Query: token, cols, rows
  Auth: same as /events (token query param)
  Frames: Binary (stdin/stdout raw bytes)
  Control: JSON messages for resize { type: "resize", cols, rows }
  Implementation: Docker exec with Tty: true, AttachStdin: true
  Close: exit code in close frame reason
```

### 2. Session `task` field in list response (blocks Slice 3)

The session list response already includes `task` — verify this is populated for all session types. The desktop app displays it as the primary description on cards. **Status: Already present in daemon Session type.**

### 3. Diff Endpoint (blocks Slice 11 clean implementation)

New route in `packages/daemon/src/api/routes/sessions.ts`:

```
GET /sessions/:sessionId/diff
  Auth: Bearer token
  Returns: {
    files: [{ path: string, status: 'added'|'modified'|'deleted', diff: string }],
    stats: { added: number, removed: number, changed: number }
  }
```

Implementation: run `git diff <baseBranch>...HEAD` inside the container or worktree.
For running sessions this gives live changes-so-far. For completed sessions, diff against
the base branch at completion time (stored in worktree or extracted from PR).

Without this endpoint, diff data is only available from `TaskReviewResult.diff` (post-validation
only), which means you can't see changes while a session is still running. That's a bad UX —
users want to peek at what the agent is building mid-flight.

---

## Build Order & Dependencies

```
Slice 0  (app target)
  └→ Slice 1  (REST client)
       └→ Slice 2  (connection)
            └→ Slice 3  (live sessions)
                 ├→ Slice 4  (event stream)  ─→ Slice 7  (live logs)
                 ├→ Slice 5  (actions)       ─→ Slice 8  (menubar + notifications)
                 ├→ Slice 6  (profiles)      ─→ Slice 9  (command palette)
                 └→ Slice 10 (validation tab)
                    └→ Slice 11 (diff view)

Slice 12 (terminal) — requires daemon WS endpoint, can parallel after Slice 4
Slice 13 (settings) — can parallel after Slice 2
```

Slices 4-6 can be parallelized after Slice 3.
Slices 7-11 can be parallelized after their prerequisites.

---

## Testing Strategy

### AutopodClient tests
- Mock `URLProtocol` to intercept HTTP requests
- Verify correct URL construction, headers, body encoding
- Verify response decoding for all types
- Test error handling (401, 404, 500, network error)
- Test EventSocket reconnect logic with mock WebSocket

### Store tests
- Mock `DaemonAPI` protocol for injection
- Test SessionStore updates from events
- Test optimistic update + rollback on error
- Test mapper functions (SessionResponse → Session)

### UI testing
- SwiftUI previews (already working) serve as visual tests
- No Xcode UI automation tests (brittle, slow)
- Manual testing checklist per slice (listed in acceptance criteria)

---

## Security

- Token stored in macOS Keychain via `Security` framework (never UserDefaults)
- Never log tokens (filter from debug output)
- HTTPS enforced for non-localhost connections (URLSession default)
- WebSocket token passed as query param (matches daemon convention — acceptable for localhost, encrypted over WSS for remote)
- No secrets in Swift source code or previews
- Mock data uses fake URLs and data only

---

## Performance

- `LazyVGrid` / `LazyVStack` for all lists (already in prototype)
- Event buffer capped at 500 global, 1000 per session
- WebSocket replay sends only events since last known ID (not full history)
- REST responses decoded on background thread, updates dispatched to `@MainActor`
- `DaemonAPI` is an `actor` — inherently thread-safe, no locks needed
- Session mapper avoids allocations in hot path (reuse date formatter)
