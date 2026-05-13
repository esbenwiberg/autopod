---
title: "Supervise dev server lifecycle and expose preview status"
depends_on: []
touches:
  - packages/daemon/src/pods/preview-supervisor.ts
  - packages/daemon/src/pods/preview-supervisor.test.ts
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/shared/src/types/pod.ts
does_not_touch:
  - packages/daemon/src/containers/aci-container-manager.ts
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/system-instructions-generator.ts
  - packages/daemon/src/pods/registry-injector.ts
  - packages/desktop/
  - packages/cli/
---

## Task

Stop transient dev-server crashes from blowing up AC validation, and
expose a status endpoint the desktop can poll.

Three changes, all in the daemon, all local-execution-target only:

1. **New module `packages/daemon/src/pods/preview-supervisor.ts`** — pure
   shell-string assembly + status parsing. Read `design.md` →
   "Contracts" for the exported signatures (`buildSupervisorCommand`,
   `parseStatus`, `PreviewStatus` shape). The shell wrapper is in
   `design.md` → "Supervisor shell wrapper" — copy it verbatim. No I/O
   in this module — it builds strings and parses strings; the engine
   does the actual `execInContainer`. Co-locate
   `preview-supervisor.test.ts` covering: command-builder snapshot
   (the produced shell string is stable), `parseStatus` with all four
   permutations of `(pid present|absent) × (reachable 200|other)`,
   `lastError` tail extraction from `start.log`.

2. **`local-validation-engine.ts` — replace fire-and-forget spawn and
   add post-Claude reachability guard.**
   - In `runHealthCheck` (line ~875), replace the
     `${startCommand} > ${startLogPath} 2>&1 &` line with
     `execInContainer(buildSupervisorCommand(startCommand))`. The
     supervisor writes the same start log path so existing log-tailing
     code keeps working — keep `startLogPath` pointing at
     `/tmp/autopod-start.log`.
   - The supervisor must NOT be torn down at the end of `runHealthCheck`
     or at the end of pages-phase. It lives until container stop. The
     existing `appStabilityMonitor` (line ~505) stays — it still drives
     mid-pages abort. Do not delete it.
   - Inside AC validation (line ~2080+), add a reachability probe
     immediately before the `page.goto` for each criterion. On failure:
     call a one-shot `restartPreview` helper (re-runs
     `buildSupervisorCommand`'s "kick" — kill the supervisor PID, spawn
     fresh) and retry the goto **once**. If the second goto also fails,
     mark the criterion failed normally — do not loop.
   - The existing pre-Claude reachability check at line ~2091 stays —
     this brief adds a *second* check after Claude generation, not a
     replacement.

3. **`pod-manager.ts` — make `startPreview` idempotent and lift
   `hasWebUi` to the pod row.**
   - `startPreview` (line ~7645): before spawning, exec
     `cat /tmp/autopod-supervisor.pid 2>/dev/null` and `kill -0 $PID`.
     If the supervisor is alive, return `{ previewUrl }` immediately
     without re-spawning. Otherwise call `buildSupervisorCommand` and
     spawn (do NOT use the old fire-and-forget line — share the
     supervisor module).
   - `processPod` provisioning path: read `profile.hasWebUi ?? false`
     once and pass it through to `podRepository.create` so it lands on
     the pod row. The pod response builder then reads it from the pod
     row.
   - **Container stop cleanup**: in the existing post-validation
     `cm.stop()` path (line ~7020), no code change needed — SIGTERM to
     PID 1 takes the supervisor's process group with it. But add a
     unit-test assertion that confirms the supervisor PID is no longer
     reachable after stop, so a future change to "remove instead of
     stop" doesn't silently break the cleanup invariant.

4. **`api/routes/pods.ts` — add `GET /pods/:podId/preview/status`.**
   Auth: pod-token or session, same as the existing `POST .../preview`
   endpoint at lines 670–674. Implementation: exec four parallel reads
   inside the container (`cat` of pid file, restart-count file, last
   200 chars of start.log, and an HTTP probe of `previewUrl`), pass the
   results through `parseStatus`, return the `PreviewStatus` plus
   `previewUrl` (see `design.md` → "Contracts"). If the container is
   stopped or doesn't exist, return `{ running: false, reachable: false,
   restartCount: 0, lastError: null, previewUrl }` — never 500.

5. **`packages/shared/src/types/pod.ts`** — add `hasWebUi: boolean`
   alongside the existing `previewUrl: string | null` (line ~106). Not
   nullable on the response; provisioning resolves it.

### Why

`local-validation-engine.ts:2105–2118` invokes Claude script generation
which takes 10–60s. The pre-existing reachability check at line 2091
fires *before* generation, so a dev-server crash during generation is
invisible until `page.goto` fails. The `appStabilityMonitor` runs every
5s with a 2-failure abort threshold — its detection window is too coarse
to catch crashes that happen and recover within ~10s, but the per-AC
`page.goto` still hits the dead window. The supervisor + post-Claude
guard close that race without abandoning the existing stability monitor.

The "always restart, never fail" policy is the user's explicit call:
visible cost (an `restartCount` ticker on the desktop) is preferred over
hidden cost (a pod that quietly stops trying to keep the dev server
alive). Don't add a give-up threshold.

`startPreview` idempotency matters because, post-this-brief, the
supervisor is started by *validation* (not just by manual preview). A
second `startPreview` call from the desktop must not spawn a parallel
supervisor.

### Constraints

- **Local execution target only.** Do not touch
  `aci-container-manager.ts`. ACI parity is a follow-up spec.
- **No DB migration.** `hasWebUi` is derived at provisioning. There is
  no `pods.has_web_ui` column today — add one only if the pod-row
  insert path requires it; a derived field on the response builder is
  fine if you can read it from the joined profile cheaply.
- **Do not change `appStabilityMonitor` semantics.** It still counts
  failures and aborts pages-phase on its own threshold. The supervisor
  layers underneath; the post-Claude guard layers on top.
- **AC reachability guard retry budget = 1.** A higher budget risks
  multi-minute hangs on legitimately-failing ACs.
- **Supervisor logs go to `/tmp/autopod-start.log`.** Don't change the
  path — existing log-tailing code at multiple sites consumes it.

### Test expectations

- `preview-supervisor.test.ts`:
  - `buildSupervisorCommand('pnpm dev')` produces a stable shell string
    (snapshot test).
  - `parseStatus` returns the right shape for each of the four
    `(pid|no-pid) × (200|other)` permutations.
  - `parseStatus` extracts the last error line from a multi-line
    start-log tail.
- `local-validation-engine.test.ts`:
  - `runHealthCheck` invokes the supervisor command exactly once and
    does not tear it down at end of phase.
  - Simulated dev-server crash during AC criterion → reachability guard
    triggers restart and retries goto exactly once.
  - Permanent failure (both gotos fail) → criterion is marked failed,
    engine keeps running for the next criterion.
  - The `appStabilityMonitor` 2-failure abort still fires when invoked
    independently (regression guard).
- `pods.test.ts`:
  - `GET /pods/:id/preview/status` on a healthy supervised pod returns
    `running=true, reachable=true, restartCount=0`.
  - Same endpoint on a stopped container returns
    `running=false, reachable=false`, status 200 (not 500).
  - Endpoint enforces pod-token auth, parallel to the POST endpoint.
- `pod-manager` tests (extend existing):
  - `startPreview` with an already-supervised container returns the
    same `previewUrl` and does not call `execInContainer` for the
    supervisor spawn a second time.
  - After `cm.stop()`, the supervisor PID is no longer alive (regression
    guard for "remove vs stop" semantics).

### Verification

Zero firing acceptance criteria — autopod's validation pipeline has no
live HTTP target it can probe against this daemon's per-pod containers,
so the user-visible outcome cannot be expressed as a firing `api`/`web`
AC and structural `cmd` checks would be theatre. Verification is the
vitest suite above + diff reviewer + a manual repro on the
teamplanner-agent profile recorded in the PR body. Same shape as
`specs/redact-spawn-log-task/brief.md`.
