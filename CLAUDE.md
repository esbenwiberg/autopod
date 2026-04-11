# Autopod Development Guide

## Quick Reference

```bash
# Install (always use npx — pnpm is not globally installed)
npx pnpm install

# Full validation pipeline (install → lint → build → test)
./scripts/validate.sh

# Individual steps
npx pnpm lint              # Biome check
npx pnpm lint:fix          # Biome auto-fix
npx pnpm build             # Turborepo build (all packages)
npx pnpm test              # Vitest (all packages)

# Single package
npx pnpm --filter @autopod/daemon test
npx pnpm --filter @autopod/cli test
npx pnpm --filter @autopod/shared test
npx pnpm --filter @autopod/escalation-mcp test
npx pnpm --filter @autopod/validator test

# Docker (when available)
./scripts/docker-validate.sh   # Build image → compose up → health check → tear down
./scripts/smoke-test.sh        # Smoke tests against a running daemon
```

## Architecture

Monorepo with pnpm workspaces. Dependency graph:

```
shared ← daemon, cli, validator, escalation-mcp
daemon ← validator, escalation-mcp
```

| Package | Purpose |
|---------|---------|
| `shared` | Types, errors, constants, sanitization. Zero heavy deps. |
| `daemon` | Fastify server, session orchestration, SQLite, Docker/ACI container management |
| `cli` | Commander CLI |
| `validator` | Playwright smoke test script generation + result parsing (types only — execution lives in daemon) |
| `escalation-mcp` | MCP server injected into agent containers for escalation, actions, and browser self-validation |
| `desktop` | macOS native app (Swift/Xcode) for session monitoring and management |

## Package Details

### @autopod/shared

Zero-dependency package providing the type backbone for the entire system.

**Types** (`src/types/`):
- `session.ts` — `SessionStatus`, `Session`, `CreateSessionRequest`, workspace pod types
- `profile.ts` — `Profile`, `StackTemplate`, `ExecutionTarget` (docker/aci), `NetworkPolicy`, `PrivateRegistry`
- `runtime.ts` — `RuntimeType` (claude/codex/copilot), `AgentEvent` union types for streaming
- `actions.ts` — Action definitions (`ActionDefinition`, `AuditEntry`) and audit trail types
- `escalation.ts` — `EscalationRequest` union: `ask_human`, `ask_ai`, `report_blocker`, `report_plan`, `report_progress`
- `validation.ts` — `SmokeResult`, `BuildResult`, `TaskReviewResult`
- `events.ts` — `SystemEvent` union types for WebSocket streaming
- `injection.ts` — Skill + MCP server injection types for container bootstrap
- `auth.ts` — Auth token and JWT payload types
- `model-provider.ts` — Credential shapes for Anthropic, Max, Foundry

**Key exports**:
- `src/errors.ts` — `AutopodError`, `AuthError`, `SessionNotFoundError`, etc.
- `src/constants.ts` — `SESSION_ID_LENGTH=8`, `CONTAINER_USER='autopod'`, `VALID_STATUS_TRANSITIONS`
- `src/sanitize/` — PII/injection pattern detection and quarantine (processor, patterns, quarantine)

### @autopod/daemon

The backend server (~176 TS/SQL files). All heavy lifting lives here.

**Session Management** (`src/sessions/`):
- `session-manager.ts` — Central orchestrator, `processSession()` loop (~2000 lines)
- `state-machine.ts` — `validateTransition()`, enforces allowed state transitions
- `session-repository.ts` — SQLite-backed CRUD for sessions
- `event-bus.ts` — Event publish/subscribe for WebSocket streaming
- `escalation-repository.ts` — Tracks in-flight and resolved escalations
- `validation-repository.ts` — Stores smoke/build/review results
- `system-instructions-generator.ts` — Builds container CLAUDE.md with injected sections + skill docs
- `skill-resolver.ts` — Resolves skill content from local files or GitHub repos
- `registry-injector.ts` — Generates `.npmrc` / `NuGet.config` for private ADO feeds
- `section-resolver.ts` — Resolves daemon-injected CLAUDE.md sections

**Container Management** (`src/containers/`):
- `docker-container-manager.ts` — Dockerode wrapper: spawn, kill, exec, file I/O, log streaming
- `docker-network-manager.ts` — Network isolation + iptables firewall (allow-all/deny-all/restricted modes)
- `aci-container-manager.ts` — Azure Container Instances backend (alternative to Docker)

**Runtimes** (`src/runtimes/`):
- `claude-runtime.ts` — Anthropic Claude via API, streams `AgentEvent` from SSE
- `codex-runtime.ts` — OpenAI Codex/GPT streaming
- `copilot-runtime.ts` — GitHub Copilot streaming
- Each runtime has a co-located stream parser with `.test.ts` coverage

**Actions System** (`src/actions/`):
- `action-engine.ts` — Executes control-plane actions from agent requests
- `action-registry.ts` — Available action definitions
- `action-audit-repository.ts` — Persists audit trail
- `handlers/` — Azure, ADO, GitHub, and generic HTTP action handlers

**API & Routes** (`src/api/`):
- `server.ts` — Fastify app factory (registers plugins + routes)
- `routes/sessions.ts` — Create, list, get, update sessions
- `routes/profiles.ts` — Profile CRUD
- `routes/health.ts` — `GET /health`, `GET /version`
- `routes/diff.ts` — Git diff retrieval
- `routes/terminal.ts` — WebSocket terminal access
- `mcp-handler.ts` — MCP server bridge for escalation tool calls
- `websocket.ts` — WebSocket event streaming to CLI/desktop
- `plugins/` — auth, cors, rate-limit, request-logger middleware

**Database** (`src/db/`):
- `connection.ts` — SQLite connection (better-sqlite3)
- `migrate.ts` — Migration runner (applies all pending `.sql` files in order)
- `migrations/` — 21 migration files (`001_initial.sql` through progressive additions for injection, execution_target, network_policy, actions, model_provider, workspace_pod, token_usage, commit_tracking, etc.)

**Profiles** (`src/profiles/`):
- `profile-store.ts` — Profile CRUD with credential encryption
- `profile-validator.ts` — Zod-based profile validation
- `inheritance.ts` — Profile extends chain resolution

**Worktrees & PR Management** (`src/worktrees/`):
- `local-worktree-manager.ts` — Git worktree operations (create, checkout, push)
- `pr-manager.ts` — `GitHubApiPrManager` — creates + merges GitHub PRs
- `ado-pr-manager.ts` — Azure DevOps PR management
- `pr-body-builder.ts` — Generates PR description from session + validation data

**Validation** (`src/validation/`):
- `local-validation-engine.ts` — Orchestrates Playwright smoke tests inside containers

**Security** (`src/crypto/`):
- `credentials-cipher.ts` — AES-256 encryption for stored credentials
- `session-tokens.ts` — HMAC-based session token issuance + validation

**Images** (`src/images/`):
- `dockerfile-generator.ts` — Dynamic Dockerfile generation per profile/stack
- `acr-client.ts` — Azure Container Registry client
- `image-builder.ts` — Image warming for ACR

**Notifications** (`src/notifications/`):
- Teams webhook adapter + rate limiter

**Test Utilities** (`src/test-utils/`):
- `mock-helpers.ts` — `createTestDb()` (in-memory SQLite + all migrations), `insertTestProfile()`, mock container/runtime/network infrastructure

### @autopod/cli

Commander-based CLI.

**Commands** (`src/commands/`):
- `auth.ts` — Login/logout via MSAL (Azure AD)
- `session.ts` — Create, list, inspect, kill sessions
- `profile.ts` — Profile CRUD
- `daemon.ts` — Health check + version
- `workspace.ts` — Workspace pod operations
- `validate.ts` — Trigger smoke test validation

**Auth** (`src/auth/`):
- `msal-client.ts` — Azure AD MSAL integration
- `token-manager.ts` — Token caching + refresh

**Config** (`src/config/`):
- `config-store.ts` — Persists to `~/.autopod/config.yaml`
- `credential-store.ts` — Secure credential storage
- `schema.ts` — Zod schema for config

### @autopod/escalation-mcp

MCP server injected into agent containers. Provides tools for agents to interact with the control plane.

**Tools exposed** (`src/tools/`):
- `ask_human` — Escalate to human reviewer (blocks until response)
- `ask_ai` — Consult another AI model
- `report_blocker` — Report a blocking issue
- `report_plan` — Report implementation plan before starting
- `report_progress` — Report phase transition
- `validate_in_browser` — Browser-based Playwright validation
- `execute_action` — Execute control-plane actions (Azure, ADO, GitHub, HTTP)
- `check_messages` — Poll for pending human messages

**Key files**:
- `src/server.ts` — `createEscalationMcpServer()` factory
- `src/session-bridge.ts` — `SessionBridge` interface (links MCP to daemon internals)
- `src/session-bridge-impl.ts` — Bridge implementation
- `src/pending-requests.ts` — Async escalation request tracking

### @autopod/validator

Thin package for Playwright test script generation and result parsing. Execution happens inside containers managed by the daemon.

- `src/playwright-script.ts` — `generateValidationScript()` — generates Playwright test code
- `src/parse-results.ts` — `parsePageResults()` — parses Playwright JSON output

### packages/desktop

macOS native app (Swift/Xcode) for session monitoring and management. Not part of the pnpm workspace — build with Xcode or `xcodebuild`.

## Build System

- **Turborepo** orchestrates tasks with `^build` dependency chains (builds `shared` before `daemon`, etc.)
- **tsup** (esbuild) compiles each package to ESM with source maps and `.d.ts` declarations
- **Biome** handles lint + format (not ESLint/Prettier)
- **Vitest** for all testing with in-memory SQLite for daemon tests

**Turborepo tasks** (`turbo.json`):
- `build` — depends on `^build` (transitive), outputs `dist/**`
- `test` — depends on `build`
- `lint` — no dependencies
- `dev` — depends on `^build`, non-cached, persistent

**TypeScript** (`tsconfig.base.json`):
- Target ES2022, module ESNext, strict mode
- `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`
- Each package extends the base config with its own paths

## Session Lifecycle (the core flow)

```
queued → provisioning → running → validating → validated → approved → merging → complete
                                     ↓                        ↓             ↓
                                   failed ←──── retry ────── rejected  merge_pending
                                                                             ↓
                                                                   fix session spawned on CI failure
                                                                   or CHANGES_REQUESTED review comments
                                                                   (up to maxPrFixAttempts, default 3)

Any non-terminal state can → killing → killed
```

Workspace pods follow a simplified flow:
```
queued → provisioning → running (interactive — no agent) → complete (auto-pushes branch on exit)
```

Key code paths:
- `packages/daemon/src/sessions/session-manager.ts:processSession()` — main orchestration loop
- `packages/daemon/src/sessions/session-manager.ts:startMergePolling()` — polls PR status every 60s; spawns fix sessions on actionable failures via `maybeSpawnFixSession()`
- `packages/daemon/src/containers/docker-container-manager.ts` — Docker operations
- `packages/daemon/src/containers/docker-network-manager.ts` — network isolation + iptables
- `packages/daemon/src/sessions/state-machine.ts` — transition validation
- `packages/daemon/src/sessions/registry-injector.ts` — `.npmrc` / `NuGet.config` generation
- `packages/daemon/src/sessions/skill-resolver.ts` — skill content resolution
- `packages/daemon/src/sessions/system-instructions-generator.ts` — container CLAUDE.md builder

## Testing Patterns

### Unit tests
Each module has a co-located `.test.ts` file. Use `createTestDb()` from
`packages/daemon/src/test-utils/mock-helpers.ts` — it wires up real SQLite with all
migrations applied + mocked container/runtime/network infrastructure.

### Docker container tests
`docker-container-manager.test.ts` tests Dockerode interactions via mock objects.
When Docker is available, `scripts/docker-validate.sh` runs real container smoke tests.

### Integration tests
- `packages/daemon/src/integration.test.ts` — Fastify HTTP endpoints with `app.inject()`
- `packages/daemon/src/sessions/session-lifecycle.e2e.test.ts` — full state machine traversal with mocked infra

### Runtime stream parser tests
Each runtime (`claude-runtime.ts`, `codex-runtime.ts`, `copilot-runtime.ts`) has a
`.test.ts` covering stream event parsing edge cases.

## Environment Variables

**Daemon** (`packages/daemon`):

| Variable | Default | Required | Notes |
|----------|---------|----------|-------|
| `PORT` | `3100` | no | HTTP bind port |
| `HOST` | `0.0.0.0` | no | HTTP bind address |
| `DB_PATH` | `./autopod.db` | no | SQLite file location |
| `LOG_LEVEL` | `info` | no | pino log level |
| `NODE_ENV` | — | yes (prod) | If `production`, auth is enforced |
| `ENTRA_CLIENT_ID` | — | yes* | Azure AD app ID (*placeholders OK in dev) |
| `ENTRA_TENANT_ID` | — | yes* | Azure AD tenant ID |
| `MAX_CONCURRENCY` | `3` | no | Session queue concurrency |
| `TEAMS_WEBHOOK_URL` | — | no | Teams notification webhook |
| `ACR_REGISTRY_URL` | — | no | Azure Container Registry for image warming |
| `AZURE_SUBSCRIPTION_ID` | — | no | Required for ACI execution target |
| `AZURE_RESOURCE_GROUP` | — | no | Required for ACI |
| `AZURE_LOCATION` | — | no | Required for ACI |
| `ACR_USERNAME` | — | no | ACR credentials for ACI |
| `ACR_PASSWORD` | — | no | ACR credentials for ACI |
| `AUTOPOD_CONTAINER_HOST` | — | no | Override host for MCP base URL inside containers |

## Environment Gotchas

- **`npx pnpm`** — pnpm is NOT globally installed. Always prefix with npx.
- **No Playwright/Chromium** — use the `validate_in_browser` MCP tool instead of running Playwright directly.
- **NODE_ENV=development** — required when dev dependencies are needed at runtime.
- **Docker may not be available** — the daemon requires Docker but the sandbox may not have it.
  Unit tests mock Dockerode and work without Docker.
- **Azure File Share** — use explicit fetch refspec: `git fetch origin +refs/heads/main:refs/remotes/origin/main`
  Wildcard fetches fail on Azure SMB mounts. Ignore `chmod on config.lock` warnings on push.

## Daemon Startup Requirements

The daemon (`packages/daemon/src/index.ts`) needs:
- Docker socket accessible (pings Docker on start, exits if unreachable)
- `ENTRA_CLIENT_ID` + `ENTRA_TENANT_ID` env vars (placeholders OK in dev)
- SQLite (auto-created at `DB_PATH`, defaults to `./autopod.db`)

In dev mode (`NODE_ENV !== 'production'`), auth is stubbed to accept all tokens.

## Security Architecture

- **Credential encryption** — AES-256 via `credentials-cipher.ts`; key stored at `~/.autopod/secrets.key`
- **Session tokens** — HMAC-based short-lived tokens issued by `session-tokens.ts`
- **Network isolation** — iptables firewall per container (`docker-network-manager.ts`):
  - `allow-all` — unrestricted outbound
  - `deny-all` — no outbound
  - `restricted` — allowlist of hosts/ports
- **PII sanitization** — `shared/src/sanitize/` strips PII + prompt injection patterns from agent output before storage
- **Git PAT stripping** — bare repos mounted into containers have PATs stripped from remote URLs

## Code Style

- Biome: 2-space indent, 100-char lines, single quotes, trailing commas, always semicolons
- Strict TypeScript: no `any`, no unused vars/params
- Test files co-located with source: `foo.ts` → `foo.test.ts`
- Mocks in `test-utils/mock-helpers.ts`, not scattered across test files
- Interfaces for all injectable infrastructure (ContainerManager, Runtime, WorktreeManager, ValidationEngine)

## PR Workflow

- Always use `gh pr create --head <branch>` — worktrees don't track remotes
- Push before creating PRs: `git push -u origin <branch>`
- Commit and push as you go — don't batch up work

## Docker / Production

The production Dockerfile is multi-stage:
1. `builder` — installs all deps, runs `pnpm build`
2. `production` — Alpine + Node 22, tini for signal handling, non-root user `autopod:1000`

Health check: `GET /health` on the configured port.
SQLite volume: `/data` (set `DB_PATH=/data/autopod.db`).

Dev image (`Dockerfile.daemon.dev`): includes all dev deps, supports hot reload.
