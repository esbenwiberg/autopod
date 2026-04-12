# Validation Plan

How to verify the complete distributed-runners feature works end-to-end.

## Integration scenarios

### 1. Register a laptop runner and run a session end-to-end

1. Start daemon on loopback with a test profile (repo = small sample repo,
   placement = `runner:laptop-test`).
2. Issue enrollment token via desktop app → copy token.
3. `cd packages/runner && pnpm start register --daemon http://localhost:3100 --token <token> --id laptop-test`.
4. Start runner: `pnpm start`.
5. Daemon log shows `runner connected: laptop-test`.
6. Create a session via CLI targeting the test profile.
7. Observe:
   - Daemon tars worktree, runner extracts it.
   - Container spawns on runner's Docker daemon.
   - Agent runs to completion; MCP escalations flow via runner proxy.
   - On container exit, runner tars workspace back.
   - Daemon pushes branch + creates PR.

### 2. Runner disconnect mid-session, reconnect, resume

1. Start scenario 1; mid-agent-loop, kill the runner process (SIGTERM).
2. Daemon detects WS close, transitions session → `runner_offline`.
3. Wait 30s. Session remains `runner_offline`.
4. Restart runner. Runner re-registers via existing credential.
5. Daemon checks container status via `get_status`; container still running.
6. Session transitions back to `running`; event stream resumes.

### 3. Runner disconnect, container dies, reconnect

1. Scenario 1; mid-loop, stop the runner *and* kill the container on the
   laptop Docker daemon (`docker kill autopod-*`).
2. Restart runner.
3. Daemon asks `get_status` → `unknown` / `stopped`.
4. Session transitions `runner_offline → failed` with reason
   `runner_reconnect_container_lost`.

### 4. Offline target queues indefinitely

1. Profile placement = `runner:laptop-test`, runner is not running.
2. Create session → session stays in `queued`.
3. Daemon logs `session queued: target runner 'laptop-test' is offline`.
4. Start runner → session proceeds through normal lifecycle.

### 5. ACI placement still works (regression)

1. Profile placement = `aci`.
2. Create session → session executes on ACI as before, no changes to existing flow.

### 6. Local-docker placement still works (regression)

1. Profile placement = `local-docker` (or unset + legacy `executionTarget: 'local'`).
2. Create session → session executes on daemon-host Docker as before.

### 7. Azure VM daemon + Pi runner swap test

1. Deploy daemon per `brief 09` to an Azure VM (Standard_B1s).
2. Connect laptop runner via Tailscale.
3. Run scenario 1. All event + workspace + MCP traffic should traverse
   the Tailscale link without error.
4. Re-deploy same daemon image to a Pi with the same env; session still
   runs against the same runner.

### 8. MCP proxy latency budget

Measure end-to-end MCP tool call latency (container → runner proxy →
daemon → response) with the daemon on a Pi reachable over Tailscale.
Acceptance: median < 50ms over a 100-call sample for a noop tool.

### 9. Workspace tar artifact exclusion

1. Session produces large `node_modules` in `/workspace`.
2. On exit, measure the tar-back payload: must exclude `node_modules`,
   `dist`, `.next`, `bin`, `obj`, `target/`.
3. Verify the daemon-side worktree after extraction has correct source
   changes but no excluded directories.

### 10. Desktop app runner management

1. Open desktop app → Runners pane shows 0 runners.
2. Click "Add runner" → enrollment token displayed; token is copyable.
3. Register + start a runner elsewhere.
4. Runner appears with `online` status and latest `lastSeenAt`.
5. Stop runner → status flips to `offline` within heartbeat interval.

## Manual checks

- Kill the WS route's Fastify plugin mid-run; verify graceful degradation.
- Force protocol version skew (runner v1, daemon v2); daemon must reject
  with a specific error visible in logs.
- Revoke a runner (`DELETE /api/runners/:id`); in-flight sessions must be
  killed, credential must be rejected on reconnect.

## Performance

- Tar upload of a 300 MB worktree must complete in < 45s on a 50 Mbps
  link (sanity; adjust for actual network).
- WS reconnect after a 15-minute offline window must complete in < 5s
  once network is restored (exponential backoff capped).

## Rollback plan

- Feature gated by the `placement` field. Unset = legacy `executionTarget`
  path. Setting placement to `local-docker` or `aci` is equivalent to the
  pre-feature behavior.
- If runner path is broken but daemon core is fine, users remove
  `placement` or set it to `aci` / `local-docker`. No migration rollback
  needed — new tables are additive.
- If daemon migration `038_runners.sql` or `039_placement.sql` causes
  issues, migrations are additive (CREATE TABLE / ADD COLUMN) and can be
  dropped manually; no data destroyed.
