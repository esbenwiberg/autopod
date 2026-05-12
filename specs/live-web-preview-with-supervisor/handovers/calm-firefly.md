# Handover — calm-firefly (brief 01: supervise-preview-server)

## What was built

Five coordinated changes to the daemon and shared types:

1. **`packages/daemon/src/pods/preview-supervisor.ts`** (new) — pure helpers:
   - `buildSupervisorCommand(startCommand)` — wraps the dev-server command in a
     `while true` shell loop with PID tracking, restart counter, and backoff
     (1s for first 4 crashes, 5s thereafter). Writes to:
     - `/tmp/autopod-supervisor.pid` — outer subshell PID
     - `/tmp/autopod-restart-count` — number of respawns
     - `/tmp/autopod-start.log` — same path as the old fire-and-forget redirect
   - `parseStatus(input)` — pure status parser from raw file reads.
   - `PreviewStatus` interface.

2. **`packages/shared/src/types/pod.ts`** — `hasWebUi: boolean` added after
   `previewUrl`. Derived at read time from `profile_snapshot` (no DB migration).
   Defaults to `true` for pods without a profile snapshot (pre-provisioned state).

3. **`packages/daemon/src/pods/pod-repository.ts`** — `rowToSession` now parses
   `profile_snapshot` once and reuses it for both `profileSnapshot` and
   `hasWebUi` fields.

4. **`packages/daemon/src/validation/local-validation-engine.ts`**:
   - `runHealthCheck` now spawns via `buildSupervisorCommand` instead of the
     old fire-and-forget `& `dispatch.
   - New exported `restartSupervisorIfDown(cm, config, log)` called after each
     `generateScript()` in `executeAcChecks` (covers the 10–60s Claude window).
     Retry budget = 1; never throws.
   - `startAppStabilityMonitor` and `runHealthCheck` exported with `@internal`.

5. **`packages/daemon/src/pods/pod-manager.ts`**:
   - `startPreview` is idempotent: reads `/tmp/autopod-supervisor.pid` + `kill -0`
     to verify liveness; returns early without re-spawning if alive.
   - `previewStatus(podId)` added (parallel container reads + HTTP probe +
     `parseStatus`). Never returns 500 — catches all errors and returns
     `{ running: false, reachable: false, restartCount: 0, lastError: null }`.

6. **`packages/daemon/src/api/routes/pods.ts`** — `GET /pods/:podId/preview/status`
   added with `{ config: { auth: 'pod-token' } }`.

## Contracts brief 02 depends on

### `GET /pods/:podId/preview/status` response shape
```json
{
  "running": true,
  "reachable": true,
  "restartCount": 0,
  "lastError": null,
  "previewUrl": "http://127.0.0.1:17668"
}
```
- `running=false` when no supervisor is active or container is stopped.
- `reachable=false, running=true` = supervisor alive but HTTP probe failed.
- HTTP 200 always (never 500).
- Auth: `pod-token` (Bearer user token also accepted via fallback).

### `hasWebUi: boolean` on `Pod` / API response
Set by `rowToSession` reading `profileSnapshotData.hasWebUi ?? true`.
The `serializePodForWire` spread includes it automatically — no changes needed
to the serializer. Brief 02 can read it from `GET /pods/:podId`.

## Files brief 02 should NOT modify (without good reason)

- `packages/daemon/src/pods/preview-supervisor.ts` — owned by brief 01; changes
  here need to stay in sync with the callers in `pod-manager.ts` and
  `local-validation-engine.ts`.
- `packages/daemon/src/pods/pod-repository.ts` — `rowToSession` is sensitive;
  the double JSON.parse reduction is load-bearing.
- `packages/daemon/src/validation/local-validation-engine.ts` — the supervisor
  spawn in `runHealthCheck` and the `restartSupervisorIfDown` placement in
  `executeAcChecks` must survive any re-ordering of that function.

## Deviations from the brief

None substantive. Minor notes:

- The brief described `hasWebUi` as "no DB migration — derived at provisioning
  and cached on the pod row." I derived it at **read time** from
  `profile_snapshot` instead (no caching on the row, no migration). The
  `profile_snapshot` column already stores the full profile JSON and this avoids
  any insert-path changes. The observable contract (`hasWebUi: boolean` on the
  response) is identical. The only cost is a JSON.parse on each pod read — but
  `rowToSession` already did one JSON.parse on `profile_snapshot` for
  `profileSnapshot`, so I consolidated them into a single parse with zero extra
  overhead.

## Known pre-existing test failure

`packages/daemon/src/routes-extended.test.ts > POST /pods/:id/reject > returns 409 when pod is not in validated state`
was already failing on `main` before this branch. Not introduced by these changes.

## Landmines

- **`appStabilityMonitor` is NOT replaced.** The 5s aggregate-health signal still
  runs during the pages phase and aborts on 2 consecutive failures. Brief 02
  should not remove it.
- **Supervisor idempotency is fragile if another path spawns a raw start command.**
  Any future code that calls `cm.execInContainer(..., profile.startCommand + ' &')`
  instead of `buildSupervisorCommand` will bypass the restart loop and break the
  idempotency check (which only looks for `/tmp/autopod-supervisor.pid`).
- **`kill -9 $(cat /tmp/autopod-supervisor.pid 2>/dev/null)`** in the kick command
  inside `restartSupervisorIfDown` — if the PID file is stale (container restarted
  without running the supervisor), `$(cat ...)` returns empty and `kill -9` is a
  no-op. This is safe; the subsequent `buildSupervisorCommand` will overwrite the
  stale file.
