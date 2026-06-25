# @autopod/daemon — Developer Guide

The daemon is the backend server: a Fastify HTTP/WebSocket process that orchestrates AI agent pods
inside Docker (or Azure Container Apps Sandboxes) containers, manages their lifecycle, runs validation, and exposes a REST API.

## Directory Structure

```
src/
├── pods/             # Core pod orchestration (state machine, manager, repositories)
├── api/              # Fastify server, routes, plugins, WebSocket, MCP proxy
├── containers/       # Docker + Sandboxes container managers, network isolation
├── runtimes/         # Claude / Codex / Copilot stream parsers
├── validation/       # Multi-phase validation engine (lint/SAST/build/test/pages/facts/review)
├── profiles/         # Profile store, inheritance resolution, Zod validation
├── actions/          # Action engine, registry, audit trail
├── db/               # SQLite connection, migration runner, .sql files
├── images/           # Dockerfile generator, ACR client, image warming
├── worktrees/        # Git worktree ops, GitHub/ADO PR management
├── providers/        # Multi-provider auth/env (Anthropic, MAX, OpenAI, Foundry, Copilot, OpenRouter)
├── notifications/    # MS Teams webhook adapter + rate limiter
├── interfaces/       # Dependency-injection abstractions (ContainerManager, Runtime, etc.)
├── crypto/           # HMAC pod tokens, AES-256 credential encryption
├── safety/           # Fleet-wide safety event detection + storage
├── scheduled-jobs/   # DB-driven scheduler + reusable templates for recurring pods
├── security/         # Per-pod security scans (secrets, deps)
├── issue-watcher/    # GitHub/ADO issue triage agents
├── history/          # Pod history queries + retention
├── util/             # Cross-subsystem helpers
└── test-utils/       # createTestDb(), mock infrastructure factories
```

## The Pod Lifecycle

```
queued → provisioning → running → validating → validated → approved → merging → complete
                                     ↓                        ↓             ↓
                                   failed ←──── retry ────── rejected  merge_pending
                                     ↓
                               review_required

Any non-terminal state → killing → killed
running → awaiting_input (escalation) → running (on response)
running → paused → running (on nudge/resume)
```

Workspace pods are simpler (interactive, no agent, no validation):
```
queued → provisioning → running → complete  (branch auto-pushed on container exit)
```

### State machine (`src/pods/state-machine.ts`)

All transitions are validated at runtime. Key helpers:
- `validateTransition(from, to)` — throws `InvalidStateTransitionError` on illegal moves
- `isTerminalState(status)` — `complete | killed`
- `canReceiveMessage(status)` — `awaiting_input | paused`
- `canPause(status)` / `canNudge(status)` / `canKill(status)`

**Never call `pod.status = x` directly** — always go through `podRepository.updateStatus()` which
calls `validateTransition` first.

## processPod() — The Orchestration Loop

`src/pods/pod-manager.ts` is the largest module in the daemon. The main phases when a pod is dequeued:

1. **Provisioning** — create/reuse git worktree, spawn container, write credential files
2. **Skill resolution** — fetch custom slash-command content (local file or GitHub); failures are non-fatal and skipped
3. **System instructions** — `system-instructions-generator.ts` builds the container's `CLAUDE.md` with:
   task description, injected sections, MCP servers, actions, skills, memories, build/start commands,
   smoke pages, required facts, contract requirements, and custom instructions
4. **Provider credentials** — inject model provider tokens (Anthropic/MAX/OpenAI/Foundry/Copilot/OpenRouter), write files into container
5. **Agent spawn / resume** — start the runtime stream; Claude supports mid-stream recovery via `claude_session_id`
6. **Event consumption** — process `AgentEvent` stream: tool-use, escalations, progress reports, completion
7. **Validation** — multi-phase: setup → lint → SAST → build → test → health → pages → facts → AI task review, with optional advisory browser QA
8. **Readiness + completion** — compute Readiness Review, merge PR (if `autoMerge`) or push branch; transition to `complete`

### Retries and validation loops

- Validation failures feed correction feedback back to the agent and loop (up to `maxValidationAttempts`, default 3)
- Human rejection via the `rejected` state resets the attempt counter for a fresh run
- `autoPauseAfterEscalations` — pod auto-pauses after N escalations if configured on the profile

### Escalation flow

1. Agent calls `ask_human` MCP tool → runtime emits `escalation` `AgentEvent`
2. Pod transitions `running → awaiting_input`
3. `pendingEscalation` stored by ID in the shared `PendingRequestsMap`
4. Human POSTs a response → `mcp-handler.ts` resolves the pending request
5. Pod transitions back to `running`; agent stream continues

The `PendingRequestsMap` is shared between `PodManager` and `MCP handler` — do not create separate instances.

### Recovery mode

If `pod.recoveryWorktreePath` is set, `processPod()` mounts the existing worktree instead of
creating a new one and resumes the Claude pod via `claude_session_id`.
The flag is cleared **immediately** (one-shot) before the container starts — it will not re-trigger on
the next run.

## Adding a New Pod State

The full checklist (5 layers + verification) lives in the `/add-pod-state` skill —
run it whenever you're adding a `PodStatus` value. Skipping a layer typically means
the state is unreachable (transition table miss) or pods land in it and idle
(`processPod()` miss).

## Database

### Connection (`src/db/connection.ts`)

- `better-sqlite3` with WAL journal mode
- Single shared connection, synchronous API
- DB file defaults to `./autopod.db`; override with `DB_PATH` env var

### Migrations (`src/db/migrate.ts` + `src/db/migrations/*.sql`)

Migrations run automatically on startup (or when `createTestDb()` is called in tests).
Files are applied in filename order — always name new files with the next sequential
prefix. Browse the dir for the canonical list; key reference points:

- `001_initial.sql` — original `profiles`, `pods`, `escalations`, `events`
- 002–021 — early waves: injection, execution_target, network_policy, validation,
  progress/resume, action policy + audit, model providers, ADO PR, skills, private
  registries, heartbeat, token usage, commit tracking
- 022–117 — recent waves: safety events (ADR-018), audit chain (ADR-019),
  network-policy snapshot (ADR-020), sleep recovery (ADR-021), legacy self-report,
  phase token usage (ADR-016), screenshot retention (ADR-017), watchdog/kick,
  preflight conflict policy, legacy AC removal, advisory browser QA defaults,
  memory learning, spec-file carryover, canonical model migration,
  `agentDonePrompt`, scheduled-job templates, validation setup command,
  OpenRouter API key, pod Readiness Review, and scheduled-template field
  overrides

**To add a migration**: create `0NN_description.sql` in `src/db/migrations/`. Never
modify existing files. Never reuse a prefix — the runner uses the prefix as the
schema version, and a duplicate is silently skipped. (A `PreToolUse` hook now
blocks colliding prefixes locally; cross-branch collisions still need manual
rebase.)

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

Creates a dedicated Docker bridge network per pod and applies iptables egress rules:
- `allow-all` — unrestricted outbound (default when no network_policy set)
- `deny-all` — blocks all outbound traffic
- `restricted` — hostname allowlist enforced through iptables + HAProxy SNI proxy

Denied restricted-egress attempts are emitted as `pod.firewall_denied` events
and can be queried through `/pods/:podId/firewall-denials`. Network and iptables
rules are torn down in `cleanup()` — always call it in the pod's finally block.

### Sandboxes (`src/containers/sandbox-container-manager.ts`)

Azure Container Apps **Sandboxes** backend — the replacement for the former ACI manager.
Implements the same `ContainerManager` interface and is selected when
`profile.executionTarget === 'sandbox'`. Activates when `AZURE_SUBSCRIPTION_ID` +
`AZURE_RESOURCE_GROUP` are set.

⚠️ **Scaffold only — not yet wired.** The preview SDK is unconfirmed, so every method
throws `NOT_IMPLEMENTED`. Run `spikes/aca-sandbox/probe.py` against an enrolled Entra
tenant to confirm the API, then implement. Unlike ACI, Sandboxes supports all
`network_policy` modes (allow-all / deny-all / restricted) via its native per-sandbox
egress policy, so the profile-validator does not reject any mode for this target.

## Runtimes

Each runtime in `src/runtimes/` implements the `Runtime` interface:
- `spawn(options)` → `AsyncIterable<AgentEvent>`
- `resume(podId, message)` → `AsyncIterable<AgentEvent>`

Stream parsers are the tricky part — each vendor's SSE format is different. When adding parser logic,
add test cases to the co-located `.test.ts` covering partial chunks, multi-event lines, and error frames.

## Validation Engine (`src/validation/local-validation-engine.ts`)

Runs inside the pod container in phases:
1. **Setup** — optional `profile.validationSetupCommand`; uses `buildTimeout`
2. **Lint** — optional `profile.lintCommand`
3. **SAST** — optional `profile.sastCommand`
4. **Build** — runs `profile.buildCommand`; captures stdout/stderr
5. **Test** — optional `profile.testCommand`
6. **Health check** — polls `profile.healthPath` until 200 or timeout
7. **Smoke pages** — `@autopod/validator` generates a Playwright script; executed inside container; results parsed
8. **Acceptance criteria** — runs executable AC checks where possible; reviewer owns non-executable checks
9. **Required facts** — executes contract proof commands and records evidence YAML
10. **AI task review** — sends diff + task description + contract context to reviewer model; returns pass/fail with notes
11. **Advisory browser QA** — optional screenshot-backed browser reviewer evidence; does not change blocking validation outcome

Each phase result is stored via `validationRepository`. The pod manager reads results to decide
whether to retry or proceed to `validated`. Advisory results are merged into
validation history and Readiness Review; blocking retries are driven by the
required validation phases.

## Profiles (`src/profiles/`)

- `profile-store.ts` — CRUD backed by SQLite; credentials encrypted with AES-256 before storage
- `inheritance.ts` — resolves the `extends` chain (deep merge, child values win)
- `profile-validator.ts` — Zod schema; call `validateProfile()` before persisting

Profiles are the primary configuration surface — runtimes, model providers,
network policy, validation setup/lint/SAST/build/test commands, advisory
browser QA defaults, agent completion prompts, MCP servers, skills, sidecars,
private registries, and action policy are all profile fields.

## Actions System (`src/actions/`)

Agents call `execute_action` via the escalation MCP server. The daemon:
1. Looks up the `ActionDefinition` in `action-registry.ts` (populated from `profile.actions`)
2. Runs the appropriate handler (`src/actions/handlers/`) — Azure, ADO, GitHub, or generic HTTP
3. Writes an audit entry to `action_audit` table via `action-audit-repository.ts`
4. Returns the result back through the MCP pending-request channel

## API Server (`src/api/server.ts`)

Fastify app with:
- **Plugins**: `cors`, `rate-limit`, `request-logger`, `auth` (stubbed in dev)
- **Routes**: `/pods`, `/profiles`, `/health`, `/diff`, `/terminal` (WebSocket),
  `/memory`, `/pods/memory-workspace`, `/scheduled-jobs`,
  `/scheduled-job-templates`, `/issue-watcher`, `/actions`, `/skills`, `/files`,
  `/screenshots`, `/pods/series`
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
`NetworkManager`, and `WorktreeManager`. Wire these into `PodManager` constructor for unit tests
that need to exercise orchestration logic without Docker.

### Integration tests

- `src/integration.test.ts` — HTTP endpoints via `app.inject()`; creates a real Fastify app with mocked infra
- `src/pods/pod-lifecycle.e2e.test.ts` — drives the full state machine with mocked container/runtime

### Stream parser tests

Each runtime has a `.test.ts` with fixture payloads. When a vendor changes their streaming format,
add a fixture here before touching the parser.

## Common Gotchas

- **Commit polling** runs in a background `setInterval` every 60 s while a pod is `running`.
  It never throws — failures are logged and swallowed. Stop it in the pod's cleanup path.

- **MAX provider token refresh** — OAuth tokens expire mid-pod. `getResumeEnv()` re-fetches a
  fresh token on every resume call. Don't cache provider credentials past a single run.

- **Skills are non-fatal** — `skill-resolver.ts` catches all errors and returns only the skills that
  resolved successfully. A GitHub fetch timeout (15 s) will silently drop that skill.

- **Workspace pods** skip validation, skip PR creation, and never auto-complete. The container
  exits when the user disconnects; the pod transitions to `complete` and the branch is pushed.

- **MCP URL rewriting** — the daemon proxies MCP calls from containers via `/api/mcp/:podId`.
  Container-side, the URL is `http://${AUTOPOD_CONTAINER_HOST}/api/mcp/${SESSION_ID}`. Override
  `AUTOPOD_CONTAINER_HOST` in dev if the container can't reach the default host.

- **Port range** — containers bind to a random port in 10 000–48 999. If you see port conflicts in
  tests, check that test teardown actually removes containers.
