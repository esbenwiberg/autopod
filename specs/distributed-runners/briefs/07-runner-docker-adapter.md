# Brief 07: Runner — Docker adapter + workspace tar

## Objective

Implement the runner-side handlers that execute `DaemonToRunner` container
operations against the local Docker socket, plus the workspace tar upload
/download pipelines.

## Dependencies

Briefs 01, 06.

## Blocked By

Brief 06 (needs `RunnerWsClient` + message router).

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/runner/src/docker/docker-adapter.ts` | create | Handlers for `spawn`, `kill`, `stop`, `start`, `exec`, `exec_stream`, `write_file`, `read_file`, `get_status`, `refresh_firewall` |
| `packages/runner/src/docker/docker-adapter.test.ts` | create | Mocks Dockerode; asserts each handler produces correct response messages |
| `packages/runner/src/workspace/upload-handler.ts` | create | Consumes `workspace_upload_start` + binary frames + `workspace_upload_end`; extracts tar into a named Docker volume |
| `packages/runner/src/workspace/download-handler.ts` | create | On `workspace_download_request`, tars the designated volume with excludes and streams back |
| `packages/runner/src/workspace/volume-store.ts` | create | Maps `sessionId` → `volumeName`; owns volume lifecycle (create on upload, remove on session cleanup) |

## Interface Contracts

None new (consumes messages defined in Brief 01, uses `RunnerWsClient` from
Brief 06).

## Implementation Notes

- Docker adapter is conceptually a mirror of
  `packages/daemon/src/containers/docker-container-manager.ts`. Where
  possible, factor shared logic into a small helper in `@autopod/shared`
  if it makes sense — but duplicate if the daemon version is tightly coupled
  to other daemon code (probably is; don't over-extract).
- Volume naming: `autopod-ws-${sessionId}` for per-session workspace
  volume. Containers bind-mount it at the path daemon specifies in
  `spawn.config.volumes`.
- The daemon still sends `volumes: [{ host, container }]` in
  `ContainerSpawnConfig`. On the runner side, rewrite `host` to the volume
  name for the session's worktree mount; other bind mounts pass through
  (these should be rare — worktree is the main one).
- Upload handler: receive `workspace_upload_start`, ensure volume exists,
  stream binary frames through `tar-stream` extractor into a temporary
  container that mounts the volume (or use Docker's `putArchive` on a
  helper container). Signal completion.
- Download handler: create a helper container with volume mounted read-only
  + run `tar -cf -` over `/workspace` with excludes (or use
  Dockerode's `getArchive`). Stream back.
- Exclude list: `node_modules`, `dist`, `.next`, `bin`, `obj`, `target`,
  `.turbo` — same list as daemon `remote-workspace-tar.ts`. Keep them in
  sync; consider exporting the list from shared if maintenance becomes
  painful.
- Cleanup hook (registered with Brief 06's watchdog): stop all
  `autopod-*` containers, remove `autopod-ws-*` volumes. Called on 60s
  watchdog trip, on graceful shutdown, and via a signal handler (SIGTERM).

## Acceptance Criteria

- [ ] Spawn message produces a running container named `autopod-${sessionId}`.
- [ ] Kill/stop/start respond with success responses that match the
  protocol schema.
- [ ] Exec returns stdout/stderr/exitCode correctly.
- [ ] ExecStreaming chunks stdout/stderr into multiple `exec_stream_chunk`
  messages ending in `exec_stream_end`.
- [ ] WriteFile/ReadFile handle text content correctly (tar stream under
  the hood).
- [ ] Workspace upload: daemon-side tar extracts into volume with correct
  file tree.
- [ ] Workspace download: excludes applied (node_modules etc. absent from
  the received tar).
- [ ] Volume lifecycle: volume removed after container kill + workspace
  download complete.
- [ ] Cleanup hook stops all autopod containers + removes volumes; safe to
  call multiple times.
- [ ] Unit tests (Vitest) with mocked Dockerode for every handler.
- [ ] Integration test against a real local Docker daemon (gated by
  `TEST_DOCKER=1` env var like existing tests).

## Estimated Scope

Files: 5 created | Complexity: high
