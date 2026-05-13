# Design — Live Web Preview With Supervisor

## Blast radius

**Daemon (7 files, 1 new):**

- `packages/daemon/src/validation/local-validation-engine.ts` — replace
  fire-and-forget spawn with supervisor invocation; add post-Claude
  reachability guard inside AC validation.
- `packages/daemon/src/validation/local-validation-engine.test.ts` —
  cover supervisor restart, reachability-guard retry, no-give-up policy.
- `packages/daemon/src/pods/pod-manager.ts` — make `startPreview`
  idempotent against an already-supervised container; lift `hasWebUi`
  from profile to pod response at provisioning; clean supervisor on
  container stop.
- `packages/daemon/src/api/routes/pods.ts` — add
  `GET /pods/:podId/preview/status`.
- `packages/daemon/src/api/routes/pods.test.ts` — endpoint coverage.
- `packages/shared/src/types/pod.ts` — add `hasWebUi: boolean` field.
- `packages/daemon/src/pods/preview-supervisor.ts` (**new**) — pure
  helpers: `buildSupervisorCommand(startCommand)`, `parseStatus(stdout)`,
  reachability probe. Keeps shell-string assembly out of the validation
  engine and out of pod-manager.

**Desktop (6 files, 0 new):**

- `packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift` —
  insert PreviewCard between Profile metadata and Artifacts.
- `packages/desktop/Sources/AutopodDesktop/Networking/DaemonAPI.swift` —
  add `previewStatus(podId)` method.
- `packages/desktop/Sources/AutopodDesktop/Models/PodResponse.swift` —
  decode `hasWebUi`.
- `packages/desktop/Sources/AutopodUI/Models/Pod.swift` — surface
  `hasWebUi` on the UI model.
- `packages/desktop/Sources/AutopodDesktop/Stores/PodMapper.swift` —
  propagate `hasWebUi` from DTO to UI model.
- `packages/desktop/Sources/AutopodUI/MockData.swift` — fixtures for
  preview-card states.

## Files we explicitly do NOT touch

- `packages/daemon/src/containers/aci-container-manager.ts` — ACI is
  out of scope (non-goal).
- `packages/daemon/src/pods/registry-injector.ts`,
  `system-instructions-generator.ts` — supervisor lives in the
  validation/preview path, not in container provisioning.
- `packages/daemon/src/db/migrations/` — no schema change. `hasWebUi` is
  derived at provisioning from the existing profile field.
- `packages/cli/` — non-goal.
- `packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift` —
  `openLiveApp(podId)` already exists at lines 489–497. Brief 02 wires
  it; the action body itself doesn't change.

## Seams

```
┌────────────────────────┐   spawn      ┌────────────────────┐
│ runHealthCheck (daemon)│ ───────────> │ supervisor (in     │
│                        │              │ container, shell)  │
└──────────┬─────────────┘              └─────────┬──────────┘
           │                                      │
           │ writes /tmp/autopod-supervisor.pid   │
           │ writes /tmp/autopod-restart-count    │
           │ appends /tmp/autopod-start.log       │
           │                                      │
           ▼                                      │
┌────────────────────────┐   exec cat   ┌─────────▼──────────┐
│ AC validation          │ <─────────── │ status state files │
│  - pre-goto reach probe│              │ (read-only)        │
│  - retry once on fail  │              └────────────────────┘
└──────────┬─────────────┘                        ▲
           │                                      │
           │                                      │
           │ ┌──────────────────────────┐         │
           └─│ preview-supervisor.ts    │─────────┘
             │ (helpers, no I/O)        │
             └──────────┬───────────────┘
                        │
                        │ used by both runHealthCheck
                        │ and pod-manager.startPreview
                        ▼
             ┌──────────────────────────┐    HTTP    ┌────────────────┐
             │ GET /pods/:id/preview/   │ <───────── │ desktop        │
             │ status                   │  poll 5s   │ PreviewCard    │
             └──────────────────────────┘            └────────────────┘
```

Three seams pin the brief boundaries:

1. **Supervisor command builder** (`preview-supervisor.ts`) is a pure
   string-assembly + parse module. Both `runHealthCheck` (validation
   path) and `startPreview` (manual preview path) use the same builder
   so behaviour is identical across both code paths. Owned by brief 01.
2. **`GET /pods/:podId/preview/status`** is the contract between daemon
   and desktop. Both briefs depend on its shape. Owned by brief 01;
   brief 02 consumes it.
3. **`hasWebUi` on `PodResponse`** crosses the wire from daemon
   (provisioning) to desktop (card gating). Owned by brief 01; brief 02
   consumes it.

## Contracts

### `preview-supervisor.ts` exports

```ts
export interface PreviewStatus {
  running: boolean;        // supervisor PID alive
  reachable: boolean;      // last reachability probe was 200
  restartCount: number;    // total respawns since supervisor start
  lastError: string | null; // tail of /tmp/autopod-start.log on last crash
}

// Builds the shell command that wraps startCommand in a never-give-up
// supervisor. Output is intended for `sh -c` inside the container.
export function buildSupervisorCommand(startCommand: string): string;

// Parses the multi-file status read from /tmp/autopod-* into PreviewStatus.
export function parseStatus(input: {
  pid: string | null;
  restartCount: string | null;
  startLogTail: string | null;
  reachableHttp: number | null; // status code from probe, or null on error
}): PreviewStatus;
```

### `GET /pods/:podId/preview/status` response

```json
{
  "running": true,
  "reachable": true,
  "restartCount": 0,
  "lastError": null,
  "previewUrl": "http://127.0.0.1:17668"
}
```

`previewUrl` echoes the existing `pod.previewUrl`. `running=false` when
no supervisor is active (e.g. before the first build, or after container
stop). `reachable=false, running=true` is the "restarting" state the
desktop renders amber.

### `PodResponse` shape extension

```ts
// packages/shared/src/types/pod.ts
export interface PodResponse {
  // ... existing fields ...
  previewUrl: string | null;   // already exists (line ~106)
  hasWebUi: boolean;           // NEW — lifted from profile.hasWebUi at provisioning
}
```

Provisioning (`pod-manager.ts` `processPod`) reads
`profile.hasWebUi ?? false` once and caches it on the pod row. The
desktop never has to fetch the profile to render the card.

### Supervisor shell wrapper

```sh
sh -c '
  i=0
  rm -f /tmp/autopod-supervisor.pid /tmp/autopod-restart-count /tmp/autopod-start.log
  echo 0 > /tmp/autopod-restart-count
  (
    while true; do
      eval "$START_COMMAND" >> /tmp/autopod-start.log 2>&1 || true
      i=$((i+1))
      echo $i > /tmp/autopod-restart-count
      if [ $i -ge 5 ]; then sleep 5; else sleep 1; fi
    done
  ) &
  echo $! > /tmp/autopod-supervisor.pid
'
```

`START_COMMAND` is exported from the supervisor wrapper so the inner
loop's `eval` runs the original `profile.startCommand` verbatim. The
outer subshell is the supervisor PID we track. Killing that PID
(SIGTERM) is enough to stop the loop; container stop kills the process
group anyway.

## UX flows

### Preview card states

```
┌─ Preview ────────────────────────────┐
│ ● Running           restarts: 0      │
│ http://127.0.0.1:17668   [ copy ]   │
│ [ ▶  Open live app ]                 │
└──────────────────────────────────────┘
```

States and triggers:

- **● Running** (green dot) — `running && reachable`. Restart count
  hidden when zero, shown muted when > 0.
- **◐ Restarting** (amber dot) — `running && !reachable`. Restart count
  always shown. Subtitle: "Server unreachable, supervisor respawning".
  "Open live app" button still enabled — clicking calls `startPreview`
  (idempotent) and may resolve faster than the next poll tick.
- **○ Stopped** (muted dot) — `!running`. Subtitle: "No preview
  active". "Open live app" button enabled — clicking starts the
  supervisor via `startPreview`.
- **Hidden** — `profile.hasWebUi !== true`. Card not rendered.

### Polling lifecycle

- Card mounts → fetch `preview/status` immediately, then every 5s while
  pod is in `running`, `validating`, `validated`, `awaiting_input`, or
  `paused`.
- Pod transitions to a terminal status (`complete`, `killed`, `failed`)
  → polling stops within one tick.
- Card unmounts → polling stops.

### "Open live app" interaction

1. User clicks "Open live app".
2. Desktop calls `ActionHandler.openLiveApp(podId)` (existing,
   unchanged).
3. `openLiveApp` calls `api.startPreview(podId)`.
4. `startPreview` is now idempotent — if supervisor already running,
   returns the same `previewUrl` immediately; otherwise spawns the
   supervisor and waits for the first reachability probe.
5. Desktop opens `previewUrl` in the default browser via
   `NSWorkspace.shared.open(url)`.

## Reference reading

Executor MUST read these before starting:

- `packages/daemon/CLAUDE.md` — Validation Engine + Container Management
  sections.
- `packages/daemon/src/validation/local-validation-engine.ts` lines
  875–920 (`runHealthCheck`), 505–542 (`startAppStabilityMonitor`),
  2080–2120 (AC validation reachability check + Claude generation race).
- `packages/daemon/src/pods/pod-manager.ts` lines 7645–7720 (existing
  `startPreview` implementation; this is the canonical "how to spawn the
  start command in a stopped container" code path), 1635–1665
  (`schedulePreviewAutoStop` 10-min timer; left unchanged but read so
  brief 01 doesn't accidentally race with it).
- `packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift`
  lines 489–497 — the dangling `openLiveApp` action that brief 02 wires.
- `packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift` —
  full file; brief 02 inserts the new card preserving existing section
  ordering.
- `specs/redact-spawn-log-task/brief.md` — precedent for a zero-AC brief
  in this repo (we follow the same shape).

## Brief order and concurrency

Two gates, sequential:

- **Gate 1** — brief 01 (supervise-preview-server). Lands the
  supervisor, the status endpoint, the AC reachability guard, and the
  `hasWebUi` field on `PodResponse`.
- **Gate 2** — brief 02 (render-preview-card). Depends on the
  `preview/status` endpoint and the `hasWebUi` field. Cannot land
  before gate 1.

There is no parallelism between the two — brief 02 needs both contracts
brief 01 ships.

## Risks the executor should know

- **Supervisor restart on a permanent failure** loops forever by design
  (per the user's "Always restart, never fail" call). The 5s backoff
  after the 5th crash limits CPU burn but does not stop. The visible
  signal is the `restartCount` shown amber on the desktop card. If a
  pod's dev server is genuinely broken, the operator sees the count
  climb and can kill the pod. **Do not add a give-up threshold.**
- **`startPreview` idempotency** matters because the supervisor is now
  started during validation (not just on manual preview). A second
  `startPreview` call from the desktop must not spawn a parallel
  supervisor — check `/tmp/autopod-supervisor.pid` and probe the PID
  before respawning.
- **Container stop semantics.** `cm.stop()` sends SIGTERM to PID 1 and
  the container's process group goes with it. The supervisor's PID file
  becomes stale; brief 01's `previewStatus` must treat "PID file exists
  but process not alive" as `running=false` (not `running=true,
  reachable=false`). Easy to get wrong.
- **AC reachability guard retry budget = 1.** A single retry covers
  transient crashes during Claude generation. Looping more than that
  risks turning every legitimately-failing AC into a multi-minute hang.
- **Polling on the desktop** uses `Timer.publish` — make sure the timer
  is invalidated on view disappear AND on pod terminal-status
  transition; otherwise a closed pod page leaks a 5s ticker.
