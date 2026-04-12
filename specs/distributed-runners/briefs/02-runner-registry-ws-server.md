# Brief 02: Daemon — runner registry + WebSocket server

## Objective

Persist registered runners, issue + verify credentials, expose the
WebSocket endpoint runners connect to, and route incoming messages to a
per-runner connection object.

## Dependencies

Brief 01 (protocol contracts).

## Blocked By

Brief 01.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/db/migrations/038_runners.sql` | create | `runners` and `runner_enrollments` tables (see contracts.md) |
| `packages/daemon/src/runners/runner-repository.ts` | create | CRUD for `runners` + `runner_enrollments` |
| `packages/daemon/src/runners/runner-credentials.ts` | create | HMAC-based credential issue + verify (mirror `session-tokens.ts`) |
| `packages/daemon/src/runners/runner-registry.ts` | create | In-memory map of runner id → `RunnerConnection`; `getConnection(id)`, `markOffline(id)`, `markOnline(id, conn)` |
| `packages/daemon/src/runners/runner-connection.ts` | create | Wraps a single WS connection; serialises outbound messages, awaits correlated responses, routes inbound messages to registered handlers |
| `packages/daemon/src/api/routes/runners.ts` | create | `POST /api/runners/enrollments`, `POST /api/runners/:id/register`, `DELETE /api/runners/:id`, `GET /api/runners/:id/ws` |
| `packages/daemon/src/api/server.ts` | modify | Register the new routes plugin (append one line; shared file) |

## Interface Contracts

### `RunnerRegistry` (consumed by Briefs 03, 05)

```ts
export interface RunnerRegistry {
  getConnection(runnerId: string): RunnerConnection | null;
  isOnline(runnerId: string): boolean;
  onConnect(runnerId: string, fn: (conn: RunnerConnection) => void): () => void;
  onDisconnect(runnerId: string, fn: () => void): () => void;
}
```

### `RunnerConnection`

```ts
export interface RunnerConnection {
  runnerId: string;
  sendRequest<T extends DaemonToRunner, R extends RunnerToDaemon>(msg: T): Promise<R>;
  sendNotification(msg: DaemonToRunner): void;
  onMessage(fn: (msg: RunnerToDaemon) => void): () => void;
  onClose(fn: (reason: string) => void): () => void;
  uploadBinary(id: string, stream: Readable): Promise<void>;
  receiveBinary(id: string): AsyncIterable<Buffer>;
}
```

## Implementation Notes

- Use the existing Fastify WebSocket plugin pattern from
  `packages/daemon/src/api/websocket.ts` — don't add a new plugin.
- Credential verification mirrors `packages/daemon/src/crypto/session-tokens.ts`
  but with derivation salt `"runner-credentials"`. Credentials are
  long-lived (no TTL); revocation is by deleting the runner row.
- Enrollment tokens are single-use: check `consumed_at IS NULL` on verify;
  set `consumed_at` atomically on first successful registration.
- Auth on `/ws` upgrade: parse `Authorization: Bearer <cred>`, verify via
  `runnerCredentials.verify(cred, runnerId)`, close with 4401 on failure.
- Don't accept `hello` messages from an already-connected runner id — close
  old connection first, mark online with new socket. Prevents split-brain.
- `runner-registry.ts` is a singleton injected into the Fastify app via
  `app.decorate('runnerRegistry', registry)`.
- Correlation table: `Map<messageId, { resolve, reject, timeoutHandle }>`.
  30s default timeout on requests; make configurable.

## Acceptance Criteria

- [ ] `038_runners.sql` applies cleanly on an empty DB and on a DB with
  existing migrations through `037`.
- [ ] `POST /api/runners/enrollments` returns a token; token is stored
  hashed (not plaintext) in `runner_enrollments`.
- [ ] `POST /api/runners/:id/register` exchanges a valid enrollment token
  for a credential and marks the enrollment `consumed_at`.
- [ ] Re-using a consumed enrollment token returns 409.
- [ ] `GET /api/runners/:id/ws` rejects with 4401 on invalid credential,
  accepts on valid.
- [ ] Duplicate runner connection: old socket closed cleanly, new socket
  replaces it in the registry.
- [ ] `DELETE /api/runners/:id` closes any live connection, deletes the row,
  emits an event consumers can listen to (for Brief 05 to kill sessions).
- [ ] Heartbeat: if no client message for `2 × heartbeat`, server closes
  the socket and calls `markOffline`.
- [ ] Unit tests cover: enrollment single-use, credential forge attempt,
  duplicate-connect dedup, heartbeat timeout, 30s request timeout.

## Estimated Scope

Files: 7 created + 1 modified | Complexity: high
