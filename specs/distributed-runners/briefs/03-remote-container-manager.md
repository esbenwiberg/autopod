# Brief 03: Daemon — RemoteContainerManager

## Objective

Implement `ContainerManager` by marshalling calls over a `RunnerConnection`.
This is the adapter that makes a runner look like a local Docker to the
rest of the daemon.

## Dependencies

Briefs 01, 02.

## Blocked By

Brief 02 (for `RunnerRegistry` + `RunnerConnection` types).

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/containers/remote-container-manager.ts` | create | Implements `ContainerManager` |
| `packages/daemon/src/containers/remote-container-manager.test.ts` | create | Mocks `RunnerConnection`, asserts message shapes per method |
| `packages/daemon/src/containers/remote-workspace-tar.ts` | create | Helpers: `tarDirectory(path, excludes)`, `extractTar(stream, destPath)` |

## Interface Contracts

`RemoteContainerManager` implements the `ContainerManager` interface from
`packages/daemon/src/interfaces/container-manager.ts` unchanged. Additional
method for workspace handling (called by session-manager only):

```ts
uploadWorkspace(sessionId: string, sourceWorktreePath: string): Promise<void>;
downloadWorkspace(sessionId: string, destWorktreePath: string, excludes: string[]): Promise<void>;
```

## Implementation Notes

- Constructor takes `{ runnerId, registry, logger }`. On each call, fetch
  connection via `registry.getConnection(runnerId)` — if null, throw
  `RunnerOfflineError`.
- `spawn(config)` → send `spawn` message, await `spawn_result`. Return
  `containerId`. On `ok: false`, throw with `error`.
- `execStreaming` is the trickiest: send `exec_stream`, return a
  `StreamingExecResult`. `stdout`/`stderr` are `PassThrough` streams fed
  by `exec_stream_chunk` messages; `exitCode` resolves on `exec_stream_end`;
  `kill()` sends `exec_stream_kill`.
- `uploadWorkspace`: tar the worktree path (excludes: `.git/objects`, `node_modules`
  — wait, for uploads you want EVERYTHING source. Only apply excludes on
  download. Upload: tar full worktree minus `.git/objects/pack` and
  symlinks outside worktree). Send `workspace_upload_start { totalBytes }`,
  stream tar in binary frames via `conn.uploadBinary`, send
  `workspace_upload_end`.
- `downloadWorkspace`: send `workspace_download_request { excludes }`,
  receive `workspace_download_start`, consume binary frames via
  `conn.receiveBinary`, extract to `destWorktreePath`. Apply excludes:
  `node_modules`, `dist`, `.next`, `bin`, `obj`, `target/`, `.turbo`.
- Excludes list lives as an exported constant in
  `remote-workspace-tar.ts` so it's visible and grep-able.
- Use `tar-stream` (already a dep — see `docker-container-manager.ts:4`).

## Acceptance Criteria

- [ ] All `ContainerManager` methods implemented with matching wire messages.
- [ ] `spawn` returns the runner's containerId; `spawn_result { ok: false }`
  throws with the error message.
- [ ] `execStreaming` produces chunked stdout/stderr streams and resolves
  `exitCode` correctly.
- [ ] Workspace upload/download round-trips a sample directory intact
  except for the documented exclude list.
- [ ] `RunnerOfflineError` thrown for every method when runner is absent.
- [ ] Unit tests cover each method with a mocked `RunnerConnection` and
  assert the exact outbound message shape.
- [ ] Integration test: spawn a fake runner in-process, run a full
  `spawn → execInContainer → readFile → kill` cycle end to end.

## Estimated Scope

Files: 3 created | Complexity: high
