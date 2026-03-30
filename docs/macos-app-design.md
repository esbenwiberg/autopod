# Autopod Desktop — macOS App Design Spec

## Vision

A premium native macOS app for orchestrating and monitoring Autopod sessions. The app should feel like it belongs alongside OrbStack, Linear, and other best-in-class developer tools on macOS. It is a rich client over the existing daemon REST API + WebSocket events, with an added terminal WebSocket endpoint for interactive pod access.

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **UI Framework** | SwiftUI + AppKit | Native macOS feel, translucent sidebar, system notifications, menubar tray |
| **Terminal** | SwiftTerm | Native Swift terminal emulator, CoreText rendering, SwiftUI wrapper included |
| **Networking** | URLSession + async/await | Native HTTP client, `URLSessionWebSocketTask` for events + terminal |
| **State** | `@Observable` (Observation framework) | Modern SwiftUI state management, replaces Combine for most cases |
| **Persistence** | SwiftData or UserDefaults | Connection profiles, preferences, window state |
| **Build** | Xcode + SPM | Standard macOS app target with Swift Package Manager dependencies |
| **Min Target** | macOS 14 (Sonoma) | Required for `@Observable`, modern SwiftUI features |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  SwiftUI Views                   │
│  (Sidebar, Cards, Detail, Terminal, Overlays)    │
├─────────────────────────────────────────────────┤
│              View Models (@Observable)            │
│  SessionStore · ProfileStore · EventStream       │
├─────────────────────────────────────────────────┤
│                  API Client Layer                 │
│  AutopodClient (REST) · EventSocket (WS)         │
│  TerminalSocket (WS — new endpoint)              │
├─────────────────────────────────────────────────┤
│               Daemon (existing)                   │
│  Fastify REST API · /events WS · /terminal WS    │
└─────────────────────────────────────────────────┘
```

### New Daemon Endpoint Required

The daemon needs a new WebSocket endpoint for interactive terminal access:

```
WS /sessions/:sessionId/terminal
  Query: token, cols, rows
  Frames: Binary (stdin/stdout raw bytes)
  Control: JSON messages for resize { type: "resize", cols, rows }
```

Implementation: create a Docker exec with `Tty: true`, `AttachStdin: true`, pipe the exec stream bidirectionally over the WebSocket. This bridges the gap between `ap attach` (local docker CLI) and remote access.

---

## Views & Navigation

### 1. Primary Layout — Command Center

Three-column NavigationSplitView:

```
┌──────────┬─────────────────┬──────────────────────────────────┐
│ Sidebar  │   Session List   │         Detail Panel             │
│          │                  │                                  │
│ Filters  │  Sorted/grouped  │  Session info, escalation,      │
│ Profiles │  session rows    │  plan, activity, terminal, diff  │
│ Stats    │                  │                                  │
└──────────┴─────────────────┴──────────────────────────────────┘
```

**Sidebar (narrow, ~180px):**
- Connection indicator (green dot / daemon URL)
- "New Session" button (prominent)
- Smart groups:
  - Attention (badge count) — escalations + validated + failed
  - Running (badge count)
  - Completed
  - All Sessions
- Separator
- Profiles list (filterable)
- Settings gear at bottom

**Session List (middle, ~280px):**
- Compact rows with: status dot, branch name, task (truncated), duration, mini progress bar
- Grouped by status category (Attention first, then Running, then Recent)
- Search/filter bar at top
- Right-click context menu for quick actions
- Keyboard navigable (arrow keys)

**Detail Panel (remaining space):**
- Segmented header: Overview | Terminal | Diff | Logs | Validation
- Content varies by tab (see below)

### 2. Card Overview — "Fleet View"

An alternative top-level view toggled via toolbar segmented control: `[List] [Cards]`

```
┌─────────────────────────────────────────────────────────────────────┐
│  ⌘K Search          Autopod          [List] [Cards]    + New    ⚙  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  NEEDS ATTENTION                                                    │
│  ┌──────────────────────┐ ┌──────────────────────┐ ┌────────────┐  │
│  │ ● feat/oauth         │ │ ● feat/cart          │ │ ● fix/perf │  │
│  │ my-app               │ │ webapp               │ │ backend    │  │
│  │ ─────────────────    │ │ ─────────────────    │ │ ──────────  │  │
│  │ awaiting_input       │ │ validated            │ │ failed     │  │
│  │                      │ │                      │ │            │  │
│  │ "Which OAuth         │ │ ✅ Smoke  ✅ Tests   │ │ ❌ Build   │  │
│  │  provider should     │ │ ✅ Review            │ │  exit 1    │  │
│  │  I use?"             │ │                      │ │            │  │
│  │                      │ │ +142 -38 · 8 files   │ │ attempt    │  │
│  │ [Reply]              │ │ [Approve] [Reject]   │ │ 2/3        │  │
│  │                      │ │ [View Diff]          │ │ [Logs]     │  │
│  │ claude-opus · 5m     │ │ claude-opus · 12m    │ │ [Retry]    │  │
│  └──────────────────────┘ └──────────────────────┘ └────────────┘  │
│                                                                     │
│  RUNNING                                                            │
│  ┌──────────────────────┐ ┌──────────────────────┐ ┌────────────┐  │
│  │ ● refactor/api       │ │ ● feat/dashboard     │ │ ● fix/n+1  │  │
│  │ backend              │ │ webapp               │ │ backend    │  │
│  │ ─────────────────    │ │ ─────────────────    │ │ ──────────  │  │
│  │ ████████░░ 8/10      │ │ ████░░░░░░ 4/10     │ │ ██████░ 6  │  │
│  │ Implementation       │ │ Planning             │ │ Testing    │  │
│  │ "Writing API tests"  │ │ "Analyzing routes"   │ │ "Running   │  │
│  │                      │ │                      │ │  suite"    │  │
│  │ +89 -12 · 5 files    │ │ +23 -4 · 3 files    │ │ +45 -31   │  │
│  │ claude-opus · 8m     │ │ claude-sonnet · 3m   │ │ · 11m     │  │
│  └──────────────────────┘ └──────────────────────┘ └────────────┘  │
│                                                                     │
│  COMPLETED TODAY (8)                                     Show all ▸ │
│  ┌──────────────────────┐ ┌──────────────────────┐ ┌────────────┐  │
│  │ ✓ fix/css-grid       │ │ ✓ feat/i18n          │ │ ✓ add/api  │  │
│  │ webapp · merged      │ │ webapp · merged      │ │ backend    │  │
│  │ 2m ago · PR #142     │ │ 1h ago · PR #139     │ │ 3h ago     │  │
│  └──────────────────────┘ └──────────────────────┘ └────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Card anatomy:**

```
┌─────────────────────────────┐
│ ● status-dot  branch-name   │  ← Status color + branch
│ profile-name                │  ← Repo/profile context
│ ─────────────────────────── │
│ [status-specific content]   │  ← Varies by state (see below)
│                             │
│ [context / metrics]         │  ← Files changed, lines, duration
│ [action buttons]            │  ← Primary actions for this state
│                             │
│ model · duration            │  ← Footer metadata
└─────────────────────────────┘
```

**Status-specific card content:**

| Status | Card Shows |
|--------|-----------|
| `queued` | Position in queue, estimated wait |
| `provisioning` | Spinner, "Setting up container..." |
| `running` | Progress bar (phase X/Y), current phase description, latest activity line |
| `awaiting_input` | Escalation question prominently displayed, suggested options, [Reply] button |
| `paused` | "Paused" label, last activity, [Resume] button |
| `validating` | Spinner with "Validating...", attempt X/Y |
| `validated` | Validation checklist (smoke/tests/review), diff stats, [Approve] [Reject] |
| `failed` | Error summary, attempt count, [Logs] [Retry] [Kill] |
| `approved` / `merging` | "Creating PR..." spinner |
| `complete` | PR link, merged timestamp, diff stats |
| `killed` | "Killed" label, reason if available |

### 3. Detail Panel Tabs

**Overview Tab:**
- Session metadata (ID, profile, branch, model, runtime, duration)
- Escalation card (if pending) with inline reply
- Plan visualization (checklist with current step highlighted)
- Progress bar with phase description
- Metrics row: tools used, edits, files changed, lines +/-
- Activity feed (recent events, filterable)
- Acceptance criteria checklist (if defined)

**Terminal Tab:**
- Full SwiftTerm terminal view
- Connects via `WS /sessions/:sessionId/terminal`
- Toolbar: shell selector (bash/sh), disconnect, clear
- Auto-connects when tab is selected for running/paused sessions
- Shows "Container not running" placeholder for terminal states

**Diff Tab:**
- Syntax-highlighted unified diff view
- File tree sidebar showing changed files
- Click file to jump to its diff
- Stats header: X files changed, +Y -Z lines
- Available for: validated, failed, complete sessions

**Logs Tab:**
- Full agent event log, scrollable
- Filter by event type (status, tool_use, file_change, escalation)
- Timestamp + event type + content
- Auto-scroll with "pin to bottom" toggle
- Search within logs

**Validation Tab:**
- Validation attempt selector (if multiple attempts)
- Results breakdown: Smoke (build, health, pages), Tests, AC Check, Task Review
- Each section expandable with details
- Screenshots from validation (inline image viewer)
- Task review reasoning and issues list

### 4. Session Creation Sheet

Presented as a `.sheet` modal:

```
┌───────────────────────────────────────┐
│          Create New Session           │
│                                       │
│  Profile     [▼ my-app           ]    │
│                                       │
│  Task                                 │
│  ┌───────────────────────────────┐    │
│  │ Add OAuth login flow with     │    │
│  │ Google and GitHub providers   │    │
│  └───────────────────────────────┘    │
│                                       │
│  Model       [▼ claude-opus      ]    │
│  Output      [▼ Pull Request     ]    │
│                                       │
│  Acceptance Criteria (optional)       │
│  ┌───────────────────────────────┐    │
│  │ + Users can sign in with G... │    │
│  │ + OAuth tokens are stored ... │    │
│  │                               │    │
│  │ [+ Add criterion]             │    │
│  └───────────────────────────────┘    │
│                                       │
│           [Cancel]  [Create]          │
└───────────────────────────────────────┘
```

### 5. Command Palette (Cmd+K)

Spotlight-style overlay for power users:

```
┌─────────────────────────────────────┐
│  🔍 Type a command or search...     │
├─────────────────────────────────────┤
│  Sessions                           │
│    feat/oauth — my-app (awaiting)   │
│    feat/cart — webapp (validated)    │
│  Actions                            │
│    New Session              ⌘N      │
│    Approve All Validated    ⌘⇧A     │
│    Kill All Failed          ⌘⇧K     │
│  Navigation                         │
│    Switch to Cards View     ⌘2      │
│    Open Settings            ⌘,      │
└─────────────────────────────────────┘
```

---

## System Integration

### Menubar Tray

Always-visible menubar icon showing fleet status at a glance:

```
┌─ 🔵 Autopod ──────────────────────┐
│                                     │
│  3 need attention                   │
│  5 running                          │
│  ───────────────────                │
│  feat/oauth    awaiting_input       │
│  feat/cart     validated            │
│  fix/perf      failed               │
│  ───────────────────                │
│  Open Dashboard            ⌘D       │
│  New Session               ⌘N       │
│  Approve All Validated     ⌘⇧A      │
│  ───────────────────                │
│  Settings...                        │
│  Quit Autopod              ⌘Q       │
└─────────────────────────────────────┘
```

Icon badge changes:
- No badge: all clear
- Red dot: sessions need attention
- Number: count of attention-needed sessions

### Notifications

Native macOS notifications for:
- Session needs input (escalation created)
- Validation completed (pass or fail)
- Session completed (PR created)
- Session failed (build error, etc.)

Notifications are actionable:
- "Approve" / "View" buttons on validation-complete notifications
- "Reply" on escalation notifications (opens app to that session)

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘N` | New session |
| `⌘K` | Command palette |
| `⌘1` | List view |
| `⌘2` | Card view |
| `⌘⇧A` | Approve all validated |
| `⌘⇧K` | Kill all failed |
| `↑/↓` | Navigate session list |
| `↩` | Open selected session |
| `⌘D` | View diff (when in detail) |
| `⌘T` | Open terminal (when in detail) |
| `⌘L` | View logs (when in detail) |
| `Esc` | Back / dismiss |

---

## Design Language

### Color Palette

Follows macOS system colors with semantic status mapping:

| Status | Color | Dot Style |
|--------|-------|-----------|
| `queued` | `.secondary` (gray) | Hollow circle |
| `provisioning` | `.blue` | Pulsing dot |
| `running` | `.green` | Solid dot |
| `awaiting_input` | `.orange` | Solid dot + glow |
| `paused` | `.yellow` | Solid dot |
| `validating` | `.blue` | Spinning arc |
| `validated` | `.green` | Checkmark badge |
| `failed` | `.red` | X badge |
| `approved` | `.green` | Double check |
| `merging` | `.purple` | Spinning arc |
| `complete` | `.secondary` | Filled check |
| `killing` | `.red` | Pulsing dot |
| `killed` | `.secondary` | Filled X |

### Typography

- SF Pro (system font) throughout
- SF Mono for: branch names, session IDs, code/diff, terminal, log entries
- Size hierarchy: Title (17pt), Headline (15pt), Body (13pt), Caption (11pt)

### Visual Effects

- Translucent sidebar (`.ultraThinMaterial`)
- Subtle card shadows with hover lift animation
- Status dot glow effect for `awaiting_input` (draws attention)
- Smooth spring animations on view transitions
- Progress bars use native `ProgressView` with accent color

### Dark & Light Mode

Full support for both, using system semantic colors:
- `.background` for main areas
- `.secondarySystemBackground` for cards
- `.tertiarySystemBackground` for nested elements
- All status colors are system-adaptive

---

## Project Structure

```
autopod/
├── packages/
│   ├── desktop/                      # New: macOS app
│   │   ├── Autopod.xcodeproj
│   │   ├── Autopod/
│   │   │   ├── App/
│   │   │   │   ├── AutopodApp.swift         # @main entry, menubar, notifications
│   │   │   │   ├── AppState.swift           # Global app state (@Observable)
│   │   │   │   └── ContentView.swift        # Root NavigationSplitView
│   │   │   ├── Models/
│   │   │   │   ├── Session.swift            # Session model (mirrors shared types)
│   │   │   │   ├── Profile.swift            # Profile model
│   │   │   │   ├── ValidationResult.swift   # Validation data
│   │   │   │   └── AgentEvent.swift         # Event types
│   │   │   ├── Stores/
│   │   │   │   ├── SessionStore.swift       # Session CRUD + polling
│   │   │   │   ├── ProfileStore.swift       # Profile management
│   │   │   │   └── EventStream.swift        # WebSocket event consumer
│   │   │   ├── Networking/
│   │   │   │   ├── AutopodClient.swift      # REST API client (async/await)
│   │   │   │   ├── EventSocket.swift        # /events WebSocket
│   │   │   │   └── TerminalSocket.swift     # /terminal WebSocket adapter
│   │   │   ├── Views/
│   │   │   │   ├── Sidebar/
│   │   │   │   │   ├── SidebarView.swift
│   │   │   │   │   └── SidebarItem.swift
│   │   │   │   ├── SessionList/
│   │   │   │   │   ├── SessionListView.swift
│   │   │   │   │   ├── SessionRow.swift
│   │   │   │   │   └── SessionFilter.swift
│   │   │   │   ├── Cards/
│   │   │   │   │   ├── CardOverview.swift    # Fleet card grid
│   │   │   │   │   ├── SessionCard.swift     # Individual session card
│   │   │   │   │   └── CardSection.swift     # Grouped card section
│   │   │   │   ├── Detail/
│   │   │   │   │   ├── DetailView.swift       # Tab container
│   │   │   │   │   ├── OverviewTab.swift
│   │   │   │   │   ├── TerminalTab.swift      # SwiftTerm integration
│   │   │   │   │   ├── DiffTab.swift
│   │   │   │   │   ├── LogsTab.swift
│   │   │   │   │   └── ValidationTab.swift
│   │   │   │   ├── Escalation/
│   │   │   │   │   ├── EscalationCard.swift   # Inline escalation UI
│   │   │   │   │   └── ReplySheet.swift
│   │   │   │   ├── Creation/
│   │   │   │   │   └── CreateSessionSheet.swift
│   │   │   │   ├── CommandPalette/
│   │   │   │   │   └── CommandPalette.swift
│   │   │   │   └── Shared/
│   │   │   │       ├── StatusDot.swift
│   │   │   │       ├── ProgressBar.swift
│   │   │   │       ├── MetricsRow.swift
│   │   │   │       └── PlanChecklist.swift
│   │   │   ├── MenuBar/
│   │   │   │   └── MenuBarView.swift
│   │   │   └── Resources/
│   │   │       └── Assets.xcassets
│   │   └── Package.swift                # SPM deps (SwiftTerm)
│   │
│   └── daemon/
│       └── src/api/
│           └── routes/
│               └── terminal.ts          # New: WS terminal endpoint
```

---

## Daemon Changes Required

### 1. WebSocket Terminal Endpoint

New file: `packages/daemon/src/api/routes/terminal.ts`

```typescript
// WS /sessions/:sessionId/terminal
// - Auth via token query param (same as /events)
// - Creates docker exec with Tty: true, AttachStdin: true
// - Bidirectional binary frames for stdin/stdout
// - JSON control frames for resize: { type: "resize", cols: N, rows: N }
// - Closes when exec exits or client disconnects
// - Returns exit code in close frame reason
```

### 2. Session Diff Endpoint

New endpoint (if not already available via validation report):

```
GET /sessions/:sessionId/diff
  Returns: { files: [{ path, status, diff }], stats: { added, removed, changed } }
```

### 3. Session Logs Endpoint

Ensure agent events are queryable:

```
GET /sessions/:sessionId/events?type=status,file_change&since=<timestamp>
  Returns: AgentEvent[]
```

---

## Implementation Phases

### Phase 1 — Foundation
- Xcode project setup with SPM
- AutopodClient (REST API client)
- EventSocket (WebSocket event stream)
- Session/Profile models
- SessionStore + ProfileStore
- Basic NavigationSplitView with sidebar + list

### Phase 2 — Core Views
- Session list with status dots, filtering, keyboard nav
- Detail panel with Overview tab
- Escalation card with inline reply
- Plan checklist + progress bar
- Activity feed
- Session creation sheet

### Phase 3 — Card Overview
- Card grid layout with sections
- Session card component with status-specific content
- Inline action buttons on cards
- Toggle between List and Cards view

### Phase 4 — Terminal
- Daemon: WebSocket terminal endpoint
- TerminalSocket adapter (SwiftTerm <-> WebSocket)
- Terminal tab in detail panel
- Resize handling, disconnect/reconnect

### Phase 5 — Diff & Validation
- Diff viewer with syntax highlighting
- File tree for changed files
- Validation results breakdown
- Screenshot viewer for validation
- Validation attempt navigation

### Phase 6 — System Integration
- Menubar tray with fleet status
- Native notifications (actionable)
- Command palette (Cmd+K)
- Keyboard shortcuts
- Dark/light mode polish

### Phase 7 — Polish
- Animations and transitions
- Performance optimization (lazy loading, virtualized lists)
- Error handling and offline state
- Connection management (auto-reconnect, multi-daemon)
- App icon and branding
