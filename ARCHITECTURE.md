# Architecture

This document covers system design — how the pieces fit together and why they're built that way. For CLI reference and configuration options, see [README.md](README.md). For hard architectural decisions with full context and consequences, see [docs/decisions/](docs/decisions/).

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Operator interfaces                                            │
│  ┌───────────────┐  ┌───────────────┐  ┌────────────────────┐  │
│  │   macOS app   │  │   CLI (ap)    │  │  Teams / webhooks  │  │
│  │  (SwiftUI)    │  │  (Commander)  │  │                    │  │
│  └───────┬───────┘  └───────┬───────┘  └─────────┬──────────┘  │
└──────────┼──────────────────┼───────────────────  │  ──────────┘
           │  HTTP + WebSocket│                     │
┌──────────▼──────────────────▼─────────────────────▼────────────┐
│  Daemon (Fastify, Node.js 22)                                   │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Pod Manager │  │  API routes  │  │  WebSocket event bus │  │
│  │  (lifecycle  │  │  (REST)      │  │  (9 event types,     │  │
│  │   + queue)   │  │              │  │   30-day replay)     │  │
│  └──────┬───────┘  └──────────────┘  └──────────────────────┘  │
│         │                                                       │
│  ┌──────▼───────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Container   │  │  Runtimes    │  │  Validation engine   │  │
│  │  manager     │  │  Claude      │  │  (7 phases,          │  │
│  │  (Docker/ACI)│  │  Codex       │  │   Playwright,        │  │
│  └──────────────┘  │  Copilot     │  │   AI review)         │  │
│                    └──────────────┘  └──────────────────────┘  │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Profile     │  │  SQLite      │  │  Action control      │  │
│  │  store       │  │  (all state) │  │  plane               │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────┬───────────────────────┘
                                          │ spawn
┌─────────────────────────────────────────▼───────────────────────┐
│  Agent containers (Docker or ACI)                               │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  AI runtime  │  │  Escalation  │  │  HAProxy (SNI proxy) │  │
│  │  (Claude /   │  │  MCP server  │  │  + iptables firewall │  │
│  │  Codex /     │  │  (13+ tools) │  │  (egress control)    │  │
│  │  Copilot)    │  │              │  │                      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Packages

| Package | Language | Role |
|---------|----------|------|
| `@autopod/shared` | TypeScript | Types, errors, constants, PII/injection sanitization. Zero heavy deps. Imported by everything else. |
| `@autopod/daemon` | TypeScript | Fastify server. Owns all state, all orchestration, all containers. The system's single source of truth. |
| `@autopod/cli` | TypeScript | Commander CLI. Thin client — calls daemon REST API, streams WebSocket events. No local state. |
| `@autopod/escalation-mcp` | TypeScript | MCP server injected into every agent container. Provides 13+ tools for structured agent ↔ human communication. |
| `@autopod/validator` | TypeScript | Playwright script generation and result parsing. Execution happens inside containers managed by the daemon. |
| `packages/desktop` | Swift | Native macOS app. HTTP + WebSocket client. Three-column layout, live terminal, diff viewer, analytics. |

Dependency graph: `shared ← daemon, cli, validator, escalation-mcp`

---

## Pod Lifecycle

Every pod is a finite state machine. The daemon enforces valid transitions — `updateStatus()` in `pod-repository.ts` is the only code path that advances state.

```
queued → provisioning → running → validating → validated → approved → merging → complete
                           │            │                                  ↓
                           │            └─→ failed (retry with feedback)  merge_pending
                           │                    │                              ↓
                           │                    └─→ review_required    fix pod spawned
                           │                           ├─→ running      (CI fail / review comments)
                           │                           └─→ running      up to maxPrFixAttempts
                           │
                           ├─→ paused
                           │      └─→ running
                           │
                           └─→ awaiting_input (agent escalated)

Any non-terminal state → killing → killed
```

Key invariants:
- State transitions are validated against `VALID_STATUS_TRANSITIONS` in `shared/src/constants.ts` before every write.
- Pod status is never set directly — always through `updateStatus()`.
- `merge_pending` exists to serialize the moment between PR creation and merge confirmation, preventing race conditions.
- `review_required` is a durable human attention signal — it replaces hard failure when retries are exhausted so work isn't silently discarded.

---

## Orchestration Loop

`pod-manager.ts:processPod()` is the main orchestration entry point. For a standard pod:

1. **Provision** — clone bare repo, strip PAT from remote URL, start Docker container (or ACI instance)
2. **Inject** — generate CLAUDE.md (task + profile sections + memories + skills), write escalation MCP config, apply network policy
3. **Run runtime** — spawn Claude/Codex/Copilot, stream `AgentEvent`s, monitor escalations
4. **Validate** — run 7-phase pipeline: build → test → health → smoke → AC → AI review → overall
5. **Retry or escalate** — on failure, send structured correction feedback and re-run agent; on exhausted retries, move to `review_required`
6. **Merge** — create PR (GitHub or ADO), poll for merge, handle CI failures by spawning fix pods

Fix pods share the parent's branch and receive the original task plus sanitized CI annotations and review comments. The ancestor chain is tracked via `linkedPodId` for UI drill-down.

---

## Container Security Model

Every agent container is isolated at five layers:

| Layer | Mechanism |
|-------|-----------|
| **Network** | Private Docker bridge (`autopod-net`), ICC disabled. In `restricted` mode: iptables NAT → HAProxy SNI proxy on loopback port 8443. HAProxy validates TLS ClientHello SNI against an allowlist and splices bytes through without MITM. Denials are logged as safety events. |
| **Syscalls** | Custom seccomp profile blocks container escape syscalls (`unshare`, `setns`, `pivot_root`, `mount`) and `AF_ALG` sockets (kernel crypto API). |
| **Capabilities** | Only `NET_ADMIN` added (for iptables). All other capabilities at Docker defaults. |
| **User** | Non-root `autopod:1000`. No privilege escalation paths. |
| **Git credentials** | Repos cloned as bare repos with auth URLs, then immediately stripped (`git remote set-url`). PATs cached in-memory on the daemon host only — never written to any container filesystem. |

All agent output (tool responses, action results, event broadcasts) passes through PII sanitization (`shared/src/sanitize/`) before storage or forwarding. Action responses additionally pass through prompt injection detection with compound threat scoring.

---

## Validation Pipeline

The 7-phase pipeline runs after the agent reports completion. Each phase gates the next.

| Phase | What runs | Configurable via |
|-------|-----------|-----------------|
| 1. Build | `profile.buildCommand` inside container | `buildCommand`, `buildTimeout` |
| 2. Test | `profile.testCommand` inside container | `testCommand`, `testTimeout` |
| 3. Health check | HTTP poll for 200 at `profile.healthPath` | `healthPath`, `healthTimeout` |
| 4. Smoke | Playwright scripts from `profile.smokePages` on daemon host | `smokePages` |
| 5. AC validation | LLM evaluates each criterion against running app in browser | `session.acceptanceCriteria` |
| 6. AI task review | Reviewer model checks diff vs original task + all prior findings | `profile.escalation.askAi.model` |
| 7. Overall | Pass only if all required phases pass | `profile.skipValidationPhases` |

**Proof-of-work screenshots** are captured at phases 4, 5, and 6 — one PNG per smoke page and AC criterion. Stored on disk under `.autopod-data/screenshots/<podId>/`, accessible via the API.

On failure, the agent receives tiered correction context: console errors, build output, screenshot diffs, AC failures, and AI reviewer notes. After `maxValidationAttempts`, the pod moves to `review_required`.

---

## Profile System

Profiles are the central configuration object. They encode everything needed to run a pod reproducibly:

- **Stack template** (`node22`, `dotnet10`, `go124`, etc.) → base Dockerfile
- **Execution target** (`local` Docker socket or `aci` Azure Container Instances)
- **Model provider** (Anthropic API, MAX/PRO OAuth, Azure Foundry, Copilot)
- **Network policy** (mode + allowlist)
- **Build / test / health / smoke commands**
- **MCP servers, CLAUDE.md sections, skills** (injected at provisioning)
- **Private registries** (npm/NuGet — credentials injected as `.npmrc`/`NuGet.config`)
- **Escalation settings** (ask_human, ask_ai, auto-pause threshold)
- **Action policy** (enabled groups, approval gates, resource restrictions)

**Versioning** — every profile update auto-increments `version`. When a pod is created, the full resolved profile (including inherited values) is snapshotted into the pod record. You can always audit exactly which config produced a given pod's output.

**Inheritance** — profiles can extend parent profiles (up to 5 levels). Arrays merge by key (skills, MCP servers: child wins on name match; smoke pages: append). Scalar fields: child takes precedence.

---

## Data Storage

All state lives in SQLite (`better-sqlite3`), at `DB_PATH` (default `./autopod.db`, production `/data/autopod.db`).

Migrations live in `packages/daemon/src/db/migrations/` as sequenced `NNN_*.sql` files. The runner uses the numeric prefix as schema version — **two files sharing the same prefix is a silent bug** (second one is skipped forever). A pre-commit hook (`migration-prefix-check.sh`) blocks collisions locally.

Key tables: `pods`, `pod_events`, `profiles`, `memories`, `escalations`, `action_audit`, `safety_events`, `quality_scores`, `scheduled_jobs`, `issue_watcher`, `series`, `validation_results`, `screenshots`.

---

## Real-time Streaming

The daemon exposes a WebSocket endpoint at `GET /ws`. Clients authenticate via token query param, then send structured messages:

```
subscribe   { type: "subscribe",     podId: "abc123" }
all         { type: "subscribe_all"                   }
replay      { type: "replay",        lastEventId: 42  }
```

The event bus persists events to `pod_events`, sanitizes PII via `processContentDeep()`, then broadcasts to all subscribed connections. Events carry monotonic `_eventId` for gap-free replay. 30-day retention. Heartbeat pings every 30s.

Nine system event types: `pod.created`, `status_changed`, `agent_activity`, `validation_started`, `validation_completed`, `escalation_created`, `escalation_resolved`, `pod.completed`, `memory.suggestion_created`.

---

## Escalation MCP Server

The `@autopod/escalation-mcp` package runs as a subprocess inside every agent container, registered as a local MCP server. It communicates back to the daemon via HTTP using a pod-scoped HMAC token.

Blocking tools (`ask_human`, `report_blocker`, `validate_in_browser`) use `PendingRequests` — a Promise-based map where the agent awaits resolution. The daemon resolves the pending request via API when a human responds or a browser check completes.

Non-blocking tools (`report_plan`, `report_progress`, `report_task_summary`, `check_messages`) fire-and-forget or return immediately.

Memory tools (`memory_suggest`, `memory_list`, `memory_read`, `memory_search`) operate on the daemon's memory store, scoped to the pod's profile and identity.

Dynamic action tools — one MCP tool per `ActionDefinition` from the profile's action policy — let agents interact with GitHub, ADO, Azure, and configured HTTP endpoints in a gated, audited, PII-sanitized way.

---

## Series Workflows

Series decompose large features into dependency-ordered pods. The spec folder contains:

- `briefs/` — one `.md` file per pod with YAML frontmatter (`title`, `task`, `depends_on`, `touches`, `does_not_touch`, `acceptance_criteria`, `context_files`)
- `purpose.md` — why this series exists (injected into every pod's CLAUDE.md)
- `design.md` — implementation design (injected into every pod's CLAUDE.md)

The daemon resolves the `depends_on` graph topologically (Kahn's algorithm) and spawns pods in order. Three PR modes:

- **`single`** — all pods share one branch; non-root pods wait for their parent to complete; only the final pod creates a PR.
- **`stacked`** — each pod gets its own PR; non-root pods wait for the parent PR to merge before starting.
- **`none`** — pods push branches, no PRs.

---

## Analytics

Six fleet dashboards, all queryable via `GET /pods/analytics/*?days=N`:

| Dashboard | Key signals |
|-----------|------------|
| **Cost** | Total spend, daily sparkline, breakdown by phase and model, waste (killed/failed pods) |
| **Reliability** | First-pass rate (0 rework), funnel drop-offs, per-stage failure rates, profile heatmap |
| **Throughput** | Pods/day, MTTM (mean time to merge), queue depth by hour, time-in-status percentiles |
| **Safety** | PII + injection events, quarantine score histogram, network policy distribution, audit chain integrity |
| **Quality** | Composite score (0–100) per pod: read:edit ratio, blind edits, validation pass, fix attempt count |
| **Escalations** | Total by type and by profile, daily sparkline |

All queries filter to a **terminal cohort**: non-workspace pods with final status (complete, killed, failed) that completed within the window.

---

## Build System

- **Turborepo** orchestrates tasks across packages with `^build` dependency chains — `shared` builds before `daemon`, `cli`, etc.
- **tsup** (esbuild) compiles each package to ESM with `.d.ts` declarations and source maps.
- **Biome** handles lint + format (replaces ESLint + Prettier).
- **Vitest** for all tests. Daemon tests use in-memory SQLite via `createTestDb()` — no Docker required.
- **Bicep** for Azure IaC (`infra/`).

Full validation pipeline: `./scripts/validate.sh` (install → lint → build → test).

---

## Deployment

The production Dockerfile is multi-stage: `builder` installs all deps and runs `pnpm build`; `production` is Alpine + Node 22 with tini for signal handling and a non-root `autopod:1000` user.

Azure target: Container Apps environment + ACR + Key Vault + Log Analytics, all managed via `infra/main.bicep`. CI/CD via GitHub Actions (`.github/workflows/deploy.yml`).

Health endpoint: `GET /health` (basic) or `GET /health?detail=full` (docker status, database, queue depth).

SQLite volume: mount `/data` and set `DB_PATH=/data/autopod.db`.
