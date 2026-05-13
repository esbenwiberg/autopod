# Live Web Preview With Supervisor

## Problem

Web pods regularly fail AC validation with `net::ERR_CONNECTION_REFUSED`
even though the dev server was healthy minutes earlier. The race lives in
`packages/daemon/src/validation/local-validation-engine.ts`:

1. `runHealthCheck` (line ~875) spawns the dev server with a fire-and-forget
   `${startCommand} > ${startLogPath} 2>&1 &` and polls `healthCheckUrl`
   until it returns 200.
2. Pages-phase reachability check passes (line ~2091).
3. Claude generates the AC validation script — this takes 10–60s.
4. AC validation calls `page.goto(previewUrl)` per criterion.
5. **If the dev server crashed any time during step 3** (OOM, hot-reload
   blip, watcher loop, plain bug), the goto fails with `ERR_CONNECTION_REFUSED`
   and every criterion is marked failed.

The existing `appStabilityMonitor` (line ~505, 5s polls / 2-failure abort)
has a 10–15s detection window that misses fast crashes during Claude
generation, and the per-criterion fallback at line ~2133 only triggers when
result markers are missing — failure markers from `page.goto` errors
**still count as markers**, so the fallback never fires.

A second user-facing gap: when a pod is running or paused for approval,
there is no first-class way for the operator to open the running app.
`startPreview`/`stopPreview` already exist on the daemon (`pod-manager.ts`
line ~7645) and the desktop already has a dangling `openLiveApp(podId)`
action (`ActionHandler.swift:489–497`) — neither is wired into any view.

## Outcome

A web pod's dev server stays observably alive from build through approval,
and the operator can open the live app from the macOS desktop without
copy-pasting URLs.

## Success signal

1. **Dev-server liveness sustained build→approval.** A pod whose dev
   server crashes mid-Claude-generation no longer flips every AC to failed
   on the next attempt — the supervisor restarts it and the AC engine
   re-probes reachability before each `page.goto`. Verified by the daemon
   vitest suite plus a manual repro on the teamplanner-agent profile (kill
   the dev server PID inside the container during Claude generation;
   confirm AC still passes).
2. **Operator can see the running app before approval.** A "Preview" card
   appears on the macOS app's pod overview tab (between Profile metadata
   and Artifacts) for any pod whose profile has `hasWebUi=true`. The card
   shows live status (Running / Restarting / Stopped), the previewUrl, and
   a primary "Open live app" button that opens the URL in the default
   browser. Verified by SwiftUI Previews plus a manual smoke recorded in
   the PR body.

Neither outcome has a firing AC: autopod's validation pipeline has no live
HTTP probe target it can hit against this daemon's per-pod containers, and
the desktop is a native SwiftUI binary with no Playwright/AppleScript
target. We accept the gap (option A in the show-back) and lean on the
diff reviewer + manual smoke. The same pattern is precedented in
`specs/redact-spawn-log-task/brief.md`.

## Users

- **Pod operators** reviewing web pods before approval — primary
  beneficiary of both the supervisor (no more transient AC failures) and
  the preview card (one-click access to the running app).
- **Workspace-pod users** — the preview card also lights up for workspace
  pods (their container persists for user interaction; the button is
  doubly useful).

## Non-goals

- **ACI execution target.** The supervisor is shell-script + container
  exec; it ships local-only. ACI parity is deferred to a follow-up.
- **Tunnelling the previewUrl outside localhost.** Card opens
  `http://127.0.0.1:<hostPort>` — same as today's `openLiveApp` action.
  Remote-access stories (ngrok, Tailscale) are out of scope.
- **Auth on previewUrl.** The dev server runs whatever auth it would run
  in `pnpm dev`; we do not inject a token gate.
- **Replacing `appStabilityMonitor`.** The monitor's 5s aggregate-health
  signal still drives the existing abort-during-pages path. The
  supervisor and the post-Claude reachability guard layer **on top** of
  it, they don't supersede it.
- **Surfacing `hasWebUi` to the CLI.** Desktop only.

## Glossary

- **Supervisor** — the shell wrapper that respawns the dev server on
  crash. Lives in the per-pod container as PID-tracked background process.
  Not to be confused with `appStabilityMonitor` (5s pulse on the daemon
  side).
- **Preview** — the live-running dev server reachable at
  `http://127.0.0.1:<hostPort>` from the host. Same URL the existing
  `startPreview` action returns.
- **Reachability** — synchronous TCP+HTTP probe of `previewUrl` returning
  one of `{reachable, unreachable, timeout}`. Distinct from "running"
  (supervisor PID alive but server might still be booting).
- **`hasWebUi`** — a profile field that already exists
  (`packages/shared/src/types/profile.ts:190`). This spec lifts it to the
  pod response so the desktop can gate the preview card without a second
  fetch.

## Reversibility

Fully reversible. No DB migration, no public API removal, no on-disk
format change. The supervisor is per-container shell state; deleting the
container takes it with it. Removing the spec means: revert
`runHealthCheck` to fire-and-forget, drop the new endpoint, delete the
preview-supervisor module, drop the desktop card. No rollback story
needed.
