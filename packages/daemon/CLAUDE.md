# @autopod/daemon — Developer Guide

The daemon is the backend server: a Fastify HTTP/WebSocket process that orchestrates AI agent sessions
inside Docker (or ACI) containers, manages their lifecycle, runs validation, and exposes a REST API.

## Directory Structure

```
src/
├── sessions/        # Core session orchestration (state machine, manager, repositories)
├── api/             # Fastify server, routes, plugins, WebSocket, MCP proxy
├── containers/      # Docker + ACI container managers, network isolation
├── runtimes/        # Claude / Codex / Copilot stream parsers
├── validation/      # Multi-phase validation engine (build, health, smoke, AI review)
├── profiles/        # Profile store, inheritance resolution, Zod validation
├── actions/         # Action engine, registry, audit trail
├── db/              # SQLite connection, migration runner, .sql files
├── images/          # Dockerfile generator, ACR client, image warming
├── worktrees/       # Git worktree ops, GitHub/ADO PR management
├── providers/       # Multi-provider auth (Anthropic, MAX, Foundry)
├── notifications/   # MS Teams webhook adapter + rate limiter
├── interfaces/      # Dependency-injection abstractions (ContainerManager, Runtime, etc.)
├── crypto/          # HMAC session tokens, AES-256 credential encryption
└── test-utils/      # createTestDb(), mock infrastructure factories
```

## The Session Lifecycle

```
queued → provisioning → running → validating → validated → approved → merging → complete
                                     ↓                        ↓
                                   failed ←──── retry ────── rejected

Any non-terminal state → killing → killed
running → awaiting_input (escalation) → running (on response)
running → paused → running (on nudge/resume)
```

Workspace pods are simpler (interactive, no agent, no validation):
```
queued → provisioning → running → complete  (branch auto-pushed on container exit)
```

### State machine (`src/sessions/state-machine.ts`)

All transitions are validated at runtime. Key helpers:
- `validateTransition(from, to)` — throws `InvalidStateTransitionError` on illegal moves
- `isTerminalState(status)` — `complete | killed | failed`
- `canReceiveMessage(status)` — `awaiting_input`
- `canPause(status)` / `canNudge(status)` / `canKill(status)`

**Never call `session.status = x` directly** — always go through `sessionRepository.updateStatus()` which
calls `validateTransition` first.

## processSession() — The Orchestration Loop

`src/sessions/session-manager.ts` (~1750 lines). The main phases when a session is dequeued:

1. **Provisioning** — create/reuse git worktree, spawn container, write credential files
2. **Skill resolution** — fetch custom slash-command content (local file or GitHub); failures are non-fatal and skipped
3. **System instructions** — `system-instructions-generator.ts` builds the container's `CLAUDE.md` with:
   task description, injected sections, MCP servers, actions, skills, build/start commands, smoke pages,
   acceptance criteria, and custom instructions
4. **Provider credentials** — inject model provider tokens (Anthropic/MAX/Foundry), write files into container
5. **Agent spawn / resume** — start the runtime stream; Claude supports mid-stream recovery via `claude_session_id`
6. **Event consumption** — process `AgentEvent` stream: tool-use, escalations, progress reports, completion
7. **Validation** — multi-phase: build → health check → Playwright smoke → AI task review
8. **Completion** — merge PR (if `autoMerge`) or push branch; transition to `complete`

### Retries and validation loops

- Validation failures feed correction feedback back to the agent and loop (up to `maxValidationAttempts`, default 3)
- Human rejection via the `rejected` state resets the attempt counter for a fresh run
- `autoPauseAfterEscalations` — session auto-pauses after N escalations if configured on the profile

### Escalation flow

1. Agent calls `ask_human` MCP tool → runtime emits `escalation` `AgentEvent`
2. Session transitions `running → awaiting_input`
3. `pendingEscalation` stored by ID in the shared `PendingRequestsMap`
4. Human POSTs a response → `mcp-handler.ts` resolves the pending request
5. Session transitions back to `running`; agent stream continues

The `PendingRequestsMap` is shared between `SessionManager` and `MCP handler` — do not create separate instances.

### Recovery mode

If `session.recoveryWorktreePath` is set, `processSession()` mounts the existing worktree instead of
creating a new one and resumes the Claude session via `claude_session_id`.
The flag is cleared **immediately** (one-shot) before the container starts — it will not re-trigger on
the next run.

## Adding a New Session State

1. Add the value to `SessionStatus` in `packages/shared/src/types/session.ts`
2. Add allowed transitions to `VALID_STATUS_TRANSITIONS` in `packages/shared/src/constants.ts`
3. Update `canX()` helpers in `state-machine.ts` if the state has behavioural meaning
4. Add a DB migration if the status needs to be persisted in a new column (rare — status is a text column)
5. Handle the new state in `session-manager.ts:processSession()`

## Database

### Connection (`src/db/connection.ts`)

- `better-sqlite3` with WAL journal mode
- Single shared connection, synchronous API
- DB file defaults to `./autopod.db`; override with `DB_PATH` env var

### Migrations (`src/db/migrate.ts` + `src/db/migrations/*.sql`)

Migrations run automatically on startup (or when `createTestDb()` is called in tests).
Files are applied in filename order — always name new files with the next sequential prefix.

| File | Adds |
|------|------|
| `001_initial.sql` | `profiles`, `sessions`, `escalations`, `events` |
| `002_...sql` | MCP servers, CLAUDE.md sections |
| `003_...sql` | `execution_target` column (docker/aci) |
| `004_...sql` | `network_policy` column |
| `005_...sql` | Validation result tables |
| `006_...sql` | `plan`/`progress` tracking, `claude_session_id` (resume), `nudge_messages` |
| `007_...sql` | `action_policy`, `output_mode`, `action_audit` table |
| `008_...sql` | `model_provider`, `provider_credentials` |
| `009–021` | Test commands, ADO PR, skills, private registries, heartbeat, token usage, commit tracking, timeouts |

**To add a migration**: create `0NN_description.sql` in `src/db/migrations/`. Never modify existing files.

## Container Management

### Docker (`src/containers/docker-container-manager.ts`)

Wraps Dockerode. Key responsibilities:
- **Spawn** — `createContainer()` builds the run config (image, env, mounts, memory limits, port bindings)
- **Port allocation** — random in range 10 000–48 999 to avoid collisions
- **Exec** — `execInContainer()` for running commands inside a live container
- **File I/O** — `writeFile()` / `readFile()` via tar stream (no `docker cp` CLI)
- **Log streaming** — `streamLogs()` returns an async iterable of log lines
- **Kill / remove** — `stopContainer()` + `removeContainer()` (always cleans up even on error)

### Network isolation (`src/containers/docker-network-manager.ts`)

Creates a dedicated Docker bridge network per session and applies iptables egress rules:
- `allow-all` — unrestricted outbound (default when no network_policy set)
- `deny-all` — blocks all outbound traffic
- `restricted` — allowlist of `host:port` pairs

Network and iptables rules are torn down in `cleanup()` — always call it in the session's finally block.

### ACI (`src/containers/aci-container-manager.ts`)

Drop-in replacement for `DockerContainerManager` implementing the same `ContainerManager` interface.
Selected when `profile.executionTarget === 'aci'`. Requires `AZURE_*` env vars.

## Runtimes

Each runtime in `src/runtimes/` implements the `Runtime` interface:
- `spawn(options)` → `AsyncIterable<AgentEvent>`
- `resume(sessionId, message)` → `AsyncIterable<AgentEvent>`

Stream parsers are the tricky part — each vendor's SSE format is different. When adding parser logic,
add test cases to the co-located `.test.ts` covering partial chunks, multi-event lines, and error frames.

## Validation Engine (`src/validation/local-validation-engine.ts`)

Runs inside the session container in phases:
1. **Build** — runs `profile.buildCommand`; captures stdout/stderr
2. **Health check** — polls `profile.healthCheckUrl` until 200 or timeout
3. **Smoke** — `@autopod/validator` generates a Playwright script; executed inside container; results parsed
4. **AI task review** — sends diff + task description to an AI model; returns pass/fail with notes

Each phase result is stored via `validationRepository`. The session manager reads results to decide
whether to retry or proceed to `validated`.

## Profiles (`src/profiles/`)

- `profile-store.ts` — CRUD backed by SQLite; credentials encrypted with AES-256 before storage
- `inheritance.ts` — resolves the `extends` chain (deep merge, child values win)
- `profile-validator.ts` — Zod schema; call `validateProfile()` before persisting

Profiles are the primary configuration surface — runtimes, network policy, MCP servers, skills,
build commands, and more are all profile fields.

## Actions System (`src/actions/`)

Agents call `execute_action` via the escalation MCP server. The daemon:
1. Looks up the `ActionDefinition` in `action-registry.ts` (populated from `profile.actions`)
2. Runs the appropriate handler (`src/actions/handlers/`) — Azure, ADO, GitHub, or generic HTTP
3. Writes an audit entry to `action_audit` table via `action-audit-repository.ts`
4. Returns the result back through the MCP pending-request channel

## API Server (`src/api/server.ts`)

Fastify app with:
- **Plugins**: `cors`, `rate-limit`, `request-logger`, `auth` (stubbed in dev)
- **Routes**: `/sessions`, `/profiles`, `/health`, `/diff`, `/terminal` (WebSocket)
- **WebSocket**: `websocket.ts` streams `SystemEvent` payloads to connected clients
- **MCP proxy**: `mcp-handler.ts` bridges HTTP POST requests from containers to the daemon's
  in-process MCP server, injecting auth and stripping PII from responses

In `NODE_ENV !== 'production'`, the auth plugin accepts all tokens — no Entra credentials needed.

## Testing

### Unit tests

Co-located `.test.ts` files. Use Vitest. Mock heavy deps (Dockerode, runtime streams) via `vi.mock()`
or by passing mock instances to constructors.

### `createTestDb()` (`src/test-utils/mock-helpers.ts`)

```ts
const { db, sessionRepo, profileRepo, ... } = await createTestDb();
```

- Creates an **in-memory SQLite** database with all migrations applied
- Returns real repository instances wired to it
- Safe to call in `beforeEach` — each call gives a fresh database

### Mock infrastructure

`mock-helpers.ts` also exports factory functions for mocked `ContainerManager`, `Runtime`,
`NetworkManager`, and `WorktreeManager`. Wire these into `SessionManager` constructor for unit tests
that need to exercise orchestration logic without Docker.

### Integration tests

- `src/integration.test.ts` — HTTP endpoints via `app.inject()`; creates a real Fastify app with mocked infra
- `src/sessions/session-lifecycle.e2e.test.ts` — drives the full state machine with mocked container/runtime

### Stream parser tests

Each runtime has a `.test.ts` with fixture payloads. When a vendor changes their streaming format,
add a fixture here before touching the parser.

## Common Gotchas

- **Commit polling** runs in a background `setInterval` every 60 s while a session is `running`.
  It never throws — failures are logged and swallowed. Stop it in the session's cleanup path.

- **MAX provider token refresh** — OAuth tokens expire mid-session. `getResumeEnv()` re-fetches a
  fresh token on every resume call. Don't cache provider credentials past a single run.

- **Skills are non-fatal** — `skill-resolver.ts` catches all errors and returns only the skills that
  resolved successfully. A GitHub fetch timeout (15 s) will silently drop that skill.

- **Workspace sessions** skip validation, skip PR creation, and never auto-complete. The container
  exits when the user disconnects; the session transitions to `complete` and the branch is pushed.

- **MCP URL rewriting** — the daemon proxies MCP calls from containers via `/api/mcp/:sessionId`.
  Container-side, the URL is `http://${AUTOPOD_CONTAINER_HOST}/api/mcp/${SESSION_ID}`. Override
  `AUTOPOD_CONTAINER_HOST` in dev if the container can't reach the default host.

- **Port range** — containers bind to a random port in 10 000–48 999. If you see port conflicts in
  tests, check that test teardown actually removes containers.
