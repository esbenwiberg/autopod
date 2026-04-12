# Contracts

Shared boundaries between briefs. Every type and message here is owned by
Brief 01 unless noted; consumer briefs import and must not redefine.

## Placement (profile + session)

```ts
// packages/shared/src/types/placement.ts (owned by Brief 04)
export type Placement =
  | { kind: 'local-docker' }
  | { kind: 'aci' }
  | { kind: 'runner'; runnerId: string };
```

Profile and Session both carry `placement: Placement | null`. `null` on
session = inherit from profile. `null` on profile = fall back to legacy
`executionTarget`.

## Runner identity

```ts
// packages/shared/src/types/runner.ts
export interface RunnerIdentity {
  id: string;              // slug, unique within a daemon, e.g. 'laptop-ewi'
  displayName: string;
  version: string;         // semver of runner binary
  capabilities: RunnerCapabilities;
}

export interface RunnerCapabilities {
  arch: 'x64' | 'arm64';
  platform: 'darwin' | 'linux';
  concurrentSessions: number;  // runner-advertised max
  hasDocker: boolean;          // sanity; false = runner rejects jobs
}

export interface RunnerRecord extends RunnerIdentity {
  status: 'online' | 'offline';
  lastSeenAt: string;          // ISO 8601
  createdAt: string;
  enrolledAt: string;
  credentialFingerprint: string; // first 16 chars of HMAC(secret)
}
```

## Enrollment flow

1. Admin issues enrollment token via `POST /api/runners/enrollments`
   (desktop or CLI). Response includes `{ enrollmentToken, ttl, runnerId }`.
2. Runner CLI: `autopod-runner register --daemon <url> --token <enrollment>`.
3. Runner generates a local keypair, posts to `POST /api/runners/:id/register`
   with the enrollment token and its public key / fingerprint.
4. Daemon verifies enrollment token, stores credential fingerprint, returns
   a long-lived **runner credential** (HMAC-signed token, same pattern as
   session tokens but with `"runner-credentials"` derivation salt).
5. Enrollment token is single-use — consumed on successful registration.

## WebSocket protocol

**Endpoint:** `GET /api/runners/:id/ws` (Fastify WebSocket route, owned by
Brief 02). Auth via `Authorization: Bearer <runner-credential>` header on
the upgrade request.

**Framing:** JSON messages on the text channel, binary frames for tar
payloads. Every request carries `id` (UUID); responses echo it.

### Runner → Daemon messages

```ts
type RunnerToDaemon =
  | { type: 'hello'; id: string; identity: RunnerIdentity; protocolVersion: number; mcpPort: number }
  | { type: 'heartbeat'; id: string; runningContainers: string[] }
  | { type: 'spawn_result'; id: string; ok: true; containerId: string }
  | { type: 'spawn_result'; id: string; ok: false; error: string }
  | { type: 'exec_result'; id: string; stdout: string; stderr: string; exitCode: number }
  | { type: 'exec_stream_chunk'; id: string; kind: 'stdout' | 'stderr'; data: string }
  | { type: 'exec_stream_end'; id: string; exitCode: number }
  | { type: 'file_read_result'; id: string; content: string }
  | { type: 'status_result'; id: string; status: 'running' | 'stopped' | 'unknown' }
  | { type: 'workspace_download_start'; id: string; sessionId: string; totalBytes: number }
  | { type: 'workspace_download_end'; id: string; sessionId: string }
  | { type: 'container_event'; sessionId: string; event: 'exited'; exitCode: number }
  | { type: 'mcp_request'; id: string; sessionId: string; method: string; path: string; headers: Record<string,string>; body: string }
  | { type: 'error'; id: string; error: string };
```

### Daemon → Runner messages

```ts
type DaemonToRunner =
  | { type: 'welcome'; protocolVersion: number; heartbeatSeconds: number }
  | { type: 'spawn'; id: string; sessionId: string; config: ContainerSpawnConfig }
  | { type: 'kill'; id: string; containerId: string }
  | { type: 'stop'; id: string; containerId: string }
  | { type: 'start'; id: string; containerId: string }
  | { type: 'exec'; id: string; containerId: string; command: string[]; options: ExecOptions }
  | { type: 'exec_stream'; id: string; containerId: string; command: string[]; options: ExecOptions & { env?: Record<string,string> } }
  | { type: 'exec_stream_kill'; id: string }
  | { type: 'write_file'; id: string; containerId: string; path: string; content: string }
  | { type: 'read_file'; id: string; containerId: string; path: string }
  | { type: 'get_status'; id: string; containerId: string }
  | { type: 'refresh_firewall'; id: string; containerId: string; script: string }
  | { type: 'workspace_upload_start'; id: string; sessionId: string; totalBytes: number }
  | { type: 'workspace_upload_end'; id: string; sessionId: string }
  | { type: 'workspace_download_request'; id: string; sessionId: string; excludes: string[] }
  | { type: 'mcp_response'; id: string; status: number; headers: Record<string,string>; body: string };
```

**Binary frames** carry tar bytes during `workspace_upload_*` /
`workspace_download_*` windows. Each binary frame is associated with the
most-recent `_start` message (by `id`) until the matching `_end` arrives.

## RemoteContainerManager ↔ Protocol mapping

`RemoteContainerManager` (Brief 03) implements `ContainerManager` by
serialising each method call into the corresponding `DaemonToRunner`
message, awaiting the matching `RunnerToDaemon` response, and returning
the promised shape. Ownership:

| ContainerManager method | Request | Response |
|--------------------------|---------|----------|
| `spawn(config)` | `spawn` | `spawn_result` |
| `kill/stop/start` | `kill/stop/start` | `exec_result` (exitCode 0 on ok) |
| `writeFile/readFile` | `write_file`/`read_file` | `exec_result`/`file_read_result` |
| `getStatus` | `get_status` | `status_result` |
| `execInContainer` | `exec` | `exec_result` |
| `execStreaming` | `exec_stream` | `exec_stream_chunk` (many) + `exec_stream_end` |
| `refreshFirewall` | `refresh_firewall` | `exec_result` |

## MCP proxy

The runner exposes `http://127.0.0.1:${RUNNER_MCP_PORT}/mcp/:sessionId` on
its loopback. Container env `AUTOPOD_CONTAINER_HOST` points at the runner
(e.g. `host.docker.internal:${RUNNER_MCP_PORT}`). On incoming HTTP:

1. Runner builds `mcp_request` with method/path/headers/body, sends over WS.
2. Daemon's `mcp-handler` (existing) processes it as if it came directly.
3. Daemon sends `mcp_response` back over WS.
4. Runner returns the HTTP response to the container.

The existing session-scoped Bearer token flow is unchanged — runner is
transparent; token validation still happens daemon-side.

## Database (owned by Brief 02 except placement)

Migration `038_runners.sql`:
```sql
CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  capabilities TEXT NOT NULL,          -- JSON RunnerCapabilities
  credential_fingerprint TEXT NOT NULL,
  credential_hash TEXT NOT NULL,       -- HMAC for verification
  enrolled_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  status TEXT NOT NULL DEFAULT 'offline'
);
CREATE TABLE runner_enrollments (
  id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
```

Migration `039_placement.sql` (owned by Brief 04) — adds `placement` JSON
column to `profiles` and `sessions`.

## Session state constants (owned by Brief 05)

`runner_offline` added to `SessionStatus` + `VALID_STATUS_TRANSITIONS` in
`packages/shared/src/types/session.ts` and `packages/shared/src/constants.ts`:
- `running → runner_offline`
- `runner_offline → running | failed | killing`

## Shared-file ownership rules

Two briefs may need to append to the same index/export files. Ownership
order:

- `packages/shared/src/index.ts` — add exports append-only. Each brief
  appends its own exports in alphabetical order; no reshuffling.
- `packages/daemon/src/api/server.ts` — each brief adds at most one
  `app.register(...)` line. Brief 02 adds the runners route; Brief 10
  adds nothing (desktop consumes existing endpoints).
- `packages/daemon/src/index.ts` — the `containerManagerFactory` is modified
  by Brief 04 (adds `remote-runner` branch) and Brief 02 (passes the
  `RunnerRegistry` into the factory). Brief 04 owns the final shape of the
  factory; Brief 02 leaves a hook (passes registry but doesn't touch
  branching).
- `packages/shared/src/types/session.ts` — Brief 04 adds `placement` field,
  Brief 05 adds `runner_offline` to `SessionStatus` union. Non-overlapping
  edits; both briefs land minimal changes, no shared lines touched.
- `packages/daemon/src/sessions/session-manager.ts` — Brief 05 is the sole
  editor (reconciliation logic). Brief 03 exposes hooks via events on a
  runner-disconnect channel, not direct edits.
