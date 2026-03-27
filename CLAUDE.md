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

# Docker (when available)
./scripts/docker-validate.sh   # Build image → compose up → health check → tear down
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
| `cli` | Commander CLI + Ink TUI dashboard |
| `validator` | Playwright smoke tests + AI task review (types only — execution lives in daemon) |
| `escalation-mcp` | MCP server injected into agent containers for escalation, actions, and browser self-validation |

## Build System

- **Turborepo** orchestrates tasks with `^build` dependency chains
- **tsup** (esbuild) compiles each package to ESM with sourcemaps
- **Biome** handles lint + format (not ESLint/Prettier)
- **Vitest** for all testing with in-memory SQLite for daemon tests

## Session Lifecycle (the core flow)

```
queued → provisioning → running → validating → validated → approved → merging → complete
                                     ↓                        ↓
                                   failed ←──── retry ────── rejected

Any non-terminal state can → killing → killed
```

Workspace pods follow a simplified flow:
```
queued → provisioning → running (interactive — no agent) → complete (auto-pushes branch on exit)
```

Key code paths:
- `session-manager.ts:processSession()` — the main orchestration loop
- `docker-container-manager.ts` — actual Docker operations (spawn, kill, exec, file I/O)
- `docker-network-manager.ts` — network isolation + iptables firewall
- `state-machine.ts` — transition validation
- `registry-injector.ts` — generates `.npmrc` / `NuGet.config` for private ADO feeds
- `skill-resolver.ts` — resolves skill content from local files or GitHub repos
- `system-instructions-generator.ts` — builds CLAUDE.md with injected sections + skill docs

## Testing Patterns

### Unit tests
Each module has co-located `.test.ts` files. Use `createTestContext()` from
`packages/daemon/src/test-utils/mock-helpers.ts` for session manager tests —
it wires up real SQLite + real repos with mocked infrastructure.

### Docker container tests
`docker-container-manager.test.ts` tests Dockerode interactions with mock objects.
When Docker is available, `scripts/docker-validate.sh` runs real container smoke tests.

### Integration tests
`integration.test.ts` — Fastify HTTP endpoint tests with `app.inject()`.
`session-lifecycle.e2e.test.ts` — full state machine traversal with mocked infra.

## Environment Gotchas

- **`npx pnpm`** — pnpm is NOT globally installed. Always prefix with npx.
- **No Playwright/Chromium** — use the validate MCP tool instead of running Playwright directly.
- **NODE_ENV=development** — required when dev dependencies are needed.
- **Docker may not be available** — the daemon requires Docker but the sandbox may not have it.
  Unit tests mock Dockerode so they work without Docker.
- **Azure File Share** — use explicit fetch refspec: `git fetch origin +refs/heads/main:refs/remotes/origin/main`
  Wildcard fetches fail on Azure SMB mounts. Ignore `chmod on config.lock` warnings on push.

## Daemon Startup Requirements

The daemon (`packages/daemon/src/index.ts`) needs:
- Docker socket accessible (pings Docker on start, exits if unreachable)
- `ENTRA_CLIENT_ID` + `ENTRA_TENANT_ID` env vars (placeholders OK in dev)
- SQLite (auto-created at `DB_PATH`, defaults to `./autopod.db`)

In dev mode (`NODE_ENV !== 'production'`), auth is stubbed to accept all tokens.

## Code Style

- Biome: 2-space indent, 100-char lines, single quotes, trailing commas, always semicolons
- Strict TypeScript: no any, no unused vars
- Test files co-located with source: `foo.ts` → `foo.test.ts`
- Mocks in `test-utils/mock-helpers.ts`, not scattered across test files

## PR Workflow

- Always use `gh pr create --head <branch>` — worktrees don't track remotes
- Push before creating PRs: `git push -u origin <branch>`
- Commit and push as you go — don't batch up work
