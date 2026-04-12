# Brief 06: Runner package — skeleton + CLI

## Objective

Create the `@autopod/runner` package with its CLI (`register`, `start`),
config store, credential persistence, and the WS client scaffold. Briefs 07
and 08 hang off the scaffold.

## Dependencies

Brief 01 (protocol types).

## Blocked By

Brief 01.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/runner/package.json` | create | ESM, tsup, commander, ws, nanoid, tar-stream, dockerode, pino |
| `packages/runner/tsup.config.ts` | create | Mirror existing package configs |
| `packages/runner/tsconfig.json` | create | Extends `tsconfig.base.json` |
| `packages/runner/README.md` | create | Minimal — points to deployment brief |
| `packages/runner/src/index.ts` | create | Re-exports for downstream (mostly types) |
| `packages/runner/src/cli.ts` | create | Commander root with `register` and `start` subcommands |
| `packages/runner/src/commands/register.ts` | create | POST `/api/runners/:id/register`, write credential |
| `packages/runner/src/commands/start.ts` | create | Load credential, open WS, wire message handlers (hooks for Briefs 07, 08) |
| `packages/runner/src/config/config-store.ts` | create | Read/write `~/.autopod/runner/config.json` (daemonUrl, runnerId, displayName, capabilities, mcpPort) |
| `packages/runner/src/config/credential-store.ts` | create | Store credential at `~/.autopod/runner/credential` with mode 0600 |
| `packages/runner/src/ws/client.ts` | create | `RunnerWsClient` — connect, send, correlation, reconnect w/ backoff |
| `packages/runner/src/ws/message-router.ts` | create | Dispatches inbound messages to registered handlers (Docker adapter in Brief 07, MCP responses in Brief 08) |
| `packages/runner/src/capabilities.ts` | create | Detect arch/platform/hasDocker at start |
| `pnpm-workspace.yaml` | modify | Add `packages/runner` (shared file — append one line) |
| `turbo.json` | modify | No changes if glob `packages/*` (check; else add) |

## Interface Contracts

```ts
// Exported from @autopod/runner for Briefs 07, 08
export interface RunnerWsClient {
  send(msg: RunnerToDaemon): void;
  request<R extends RunnerToDaemon>(msg: DaemonToRunner): Promise<R>;  // unused runner-side; request flow is daemon-initiated
  onMessage(handler: (msg: DaemonToRunner) => Promise<void> | void): () => void;
  sendBinary(id: string, chunk: Buffer): void;
  onBinary(id: string, handler: (chunk: Buffer) => void): () => void;
  onClose(handler: (reason: string) => void): () => void;
  close(reason?: string): Promise<void>;
}
```

## Implementation Notes

- CLI entry is `autopod-runner` (published via `bin` in package.json).
- `register --daemon <url> --token <enrollment> --id <runnerId> --name <displayName>`.
  Detect capabilities. POST to daemon. Store credential + config.
- `start` requires existing config + credential. Open WS with
  `Authorization: Bearer <credential>`. Send `hello`. On close, reconnect
  with exponential backoff capped at 30s. Emit `status_result` with
  runningContainers in each heartbeat (gathered from Docker in Brief 07).
- Don't attempt ARM/x64 image auto-pull magic — runner assumes the profile
  image is pullable; log errors cleanly if not.
- 60s watchdog: if WS not reconnected within 60s of drop, run cleanup hook
  (stops any containers; hook registered by Brief 07).
- Use `commander` for CLI.
- Use `ws` (library) for the client — same library as Fastify WS plugin.

## Acceptance Criteria

- [ ] `packages/runner` appears in `pnpm-workspace.yaml` and builds.
- [ ] `autopod-runner register` stores config + credential at
  `~/.autopod/runner/`.
- [ ] `autopod-runner start` connects, sends `hello`, processes `welcome`.
- [ ] Reconnect loop works on artificial WS drop (test with a toy server).
- [ ] 60s watchdog invokes registered cleanup hooks on prolonged
  disconnect.
- [ ] `capabilities.detect()` returns arch/platform/hasDocker accurately.
- [ ] Credential file mode is `0600` on creation.
- [ ] Runs on macOS (arm64) and Linux (x64) — CI matrix or smoke check.

## Estimated Scope

Files: 12 created + 1–2 modified | Complexity: medium
