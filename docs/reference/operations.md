# Operations & development

[README](../../README.md) · [Getting started](../getting-started.md) · [CLI](cli.md) · [Profiles](profiles.md) · [Validation](validation.md) · [Operations](operations.md)

## Analytics

The daemon exposes fleet metrics at `/pods/analytics/*`. All endpoints accept a `?days=N` query param (default 30, max 365).

| Endpoint | What it returns |
|----------|----------------|
| `GET /pods/analytics/cost` | Total spend, daily sparkline, breakdown by phase and by profile+model, top 10 pods by cost, waste (killed/failed) |
| `GET /pods/analytics/reliability` | First-pass rate, daily sparkline, funnel counts, drop-off points, per-stage failure rates, profile heatmap |
| `GET /pods/analytics/throughput` | Pods per day, MTTM, queue depth by hour, time-in-status percentiles |
| `GET /pods/analytics/safety` | PII + injection event counts, quarantine score histogram, network policy distribution, audit chain integrity |
| `GET /pods/analytics/quality` | Composite quality score (0–100) per pod, aggregated signals |
| `GET /pods/analytics/escalations` | Escalation counts by type and by profile |
| `GET /pods/analytics/models` | Per-model leaderboard, runtime aggregates, failure-stage matrix, and what-if inputs |
| `GET /pods/analytics/memory` | Memory effectiveness, selected/injected counts, helpful/harmful evidence |
| `GET /pods/:id/cost` | One pod's cost grouped into work, rework, validation, advisory, and unattributed buckets |

The macOS desktop app surfaces these in a dedicated Analytics tab with sparklines and drill-downs.

---

## Auth Setup

autopod uses Azure Entra ID for authentication.

1. Go to [Azure Portal](https://portal.azure.com) > **Entra ID** > **App registrations**
2. Create a new registration
3. Under **Authentication**, add Mobile and desktop redirect URIs:
   - `http://localhost` (CLI PKCE/device-code compatibility)
   - `msauth.com.autopod.desktop://auth` (macOS desktop native sign-in)
4. Add the CLI broker callback for each hosted daemon as an HTTPS redirect URI:
   - `https://<daemon-host>/auth/cli/callback`
5. Enable **"Allow public client flows"** (for CLI and device-code login)
6. Under **Expose an API**, set the Application ID URI to `api://<application-client-id>`
7. Add a delegated scope named `access_as_user`
8. Note the **Application (client) ID** and **Directory (tenant) ID**
9. Add them to your daemon `.env`:

```bash
ENTRA_CLIENT_ID=<application-client-id>
ENTRA_TENANT_ID=<directory-tenant-id>
ENTRA_AUDIENCE=api://<application-client-id>
```

For the CLI, use the same tenant/client and scope:

```bash
export AUTOPOD_CLIENT_ID=<application-client-id>
export AUTOPOD_TENANT_ID=<directory-tenant-id>
export AUTOPOD_AUTH_SCOPE=api://<application-client-id>/access_as_user
ap login
```

For the hosted desktop daemon flow, see [hosted authentication](../hosted-daemon-tls-entra.md).

---

## Deployment (Azure)

autopod ships with full Azure infrastructure as code via Bicep.

### What gets deployed

| Resource | Purpose |
|----------|---------|
| **Container Apps Environment** | Runs the daemon container |
| **Container Registry (ACR)** | Stores daemon and warmed pod images |
| **Key Vault** | Holds API keys, PATs, webhook URLs |
| **Log Analytics** | Centralized structured logging |
| **Managed Identity** | No credentials in code, ever |

### Deploy

```bash
# Dev environment
az deployment sub create \
  --location westeurope \
  --template-file infra/main.bicep \
  --parameters infra/parameters/dev.bicepparam

# Production
az deployment sub create \
  --location westeurope \
  --template-file infra/main.bicep \
  --parameters infra/parameters/prod.bicepparam
```

See the [infrastructure guide](../../infra/README.md) for the Bicep layout and
manual deployment commands.

### Health endpoint

```bash
# Basic (used by load balancer / Docker HEALTHCHECK)
GET /health
# → { "status": "ok", "version": "1.0.0" }

# Full diagnostics (ops/monitoring)
GET /health?detail=full
# → {
#     "status": "ok",
#     "version": "1.0.0",
#     "uptime_seconds": 3600,
#     "docker": { "connected": true, "containers_running": 4 },
#     "database": { "connected": true, "migrations_applied": 117 },
#     "queue": { "active_sessions": 2, "queued_sessions": 1, "max_concurrency": 3 }
#   }
```

---

## Development

### Project structure

```
autopod/
  packages/
    shared/            # Types, errors, constants, sanitization — the contract between packages
    daemon/            # Fastify server, pod orchestration, SQLite state
      src/actions/     #   Action control plane (handlers, registry, audit)
      src/providers/   #   Multi-provider model auth (env builder, credential refresh)
      src/runtimes/    #   Runtime adapters (Claude, Codex, Copilot)
      src/validation/  #   Validation pipeline (setup/lint/SAST/build/test/pages/facts/review/advisory)
      src/worktrees/   #   Git worktree + PR management (GitHub, ADO)
    cli/               # Commander CLI
    escalation-mcp/    # MCP server injected into agent containers (escalation, actions, browser validation)
    validator/         # Playwright smoke script generation + result parsing
    mobile-web/        # Phone PWA served by the daemon at /mobile/*
    desktop/           # macOS native app (SwiftUI + AppKit)
  e2e/                 # End-to-end tests
  infra/               # Azure Bicep IaC
  templates/           # Base Dockerfiles per stack
  docs/                # Architecture docs and implementation plans
  website/             # Interactive documentation site (deployed to GitHub Pages)
```

### Commands

```bash
npx pnpm install              # Install all dependencies
./scripts/validate.sh         # Full local CI loop
npx pnpm run build            # Build all packages (via Turborepo)
npx pnpm run dev              # Watch mode
npx pnpm run typecheck        # Type-check all packages
npx pnpm run test             # Run all tests (Vitest)
npx pnpm run lint             # Check with Biome
npx pnpm run lint:fix         # Auto-fix
npx pnpm run audit            # Dependency audit
npx pnpm run secret-scan      # Secret scan
```

### Run tests for a single package

```bash
npx pnpm --filter @autopod/daemon test
npx pnpm --filter @autopod/cli test
npx pnpm --filter @autopod/shared test
```

### macOS desktop app

The `packages/desktop` directory contains a native Swift/SwiftUI app (not part of the pnpm workspace). Build it with Xcode or:

```bash
cd packages/desktop
xcodebuild -scheme Autopod -configuration Debug build
```

The app connects to the same daemon via HTTP/WebSocket. Features: three-column pod browser, readiness review, evidence and action-audit panels, grouped diff viewer, validation history, memory workbench, scheduled-job templates, analytics drill-downs, and a live terminal (SwiftTerm).

### Tech stack

| Tool | Why |
|------|-----|
| **TypeScript 5.7** | Type safety from CLI to daemon to container |
| **Fastify 5** | Fast, schema-validated HTTP + WebSocket |
| **SQLite** (better-sqlite3) | Zero-config embedded state, ACID transactions |
| **Commander** | CLI argument parsing |
| **Playwright** | Real browser validation with screenshots |
| **MSAL** | Entra ID device code + PKCE auth flows |
| **Pino** | Structured JSON logging |
| **tsup** | Fast bundling via esbuild |
| **Vitest** | TypeScript-native test runner |
| **Turborepo** | Monorepo build orchestration with caching |
| **Biome** | Lint + format (replaces ESLint + Prettier) |
| **Bicep** | Azure infrastructure as code |

---

## FAQ

<details>
<summary><b>Can I use models other than Claude?</b></summary>

Yes. autopod supports multiple runtimes — set `--runtime codex` for OpenAI Codex, `--runtime copilot` for GitHub Copilot, or implement a custom runtime adapter. The runtime interface is pluggable.
</details>

<details>
<summary><b>Do I need Azure?</b></summary>

You can run agents on local Docker. Azure Container Apps Sandboxes is an alternative execution target with additional infrastructure requirements. See [execution targets](profiles.md#execution-targets). Hosted authentication uses Entra ID; see [Auth Setup](#auth-setup).
</details>

<details>
<summary><b>How much does it cost to run?</b></summary>

Agent pods are ephemeral — they spin up, do work, and die. You only pay for compute while agents are active. The daemon itself is lightweight (single container, SQLite). The main cost driver is AI API usage, not infrastructure.
</details>

<details>
<summary><b>What happens if the agent gets stuck?</b></summary>

It can escalate via MCP tools: `ask_human` pauses and notifies you, `ask_ai` gets a second opinion from `profile.reviewerModel`, `report_blocker` declares a hard stop. You can also proactively pause a pod (`ap pause`) and nudge the agent with new instructions (`ap nudge`) without killing its work.
</details>

<details>
<summary><b>Can agents access external data (issues, logs, etc.)?</b></summary>

Yes — the action control plane gives agents read access to GitHub issues/PRs, Azure DevOps work items, and Azure application logs. All responses are PII-stripped and scanned for prompt injection before reaching the agent.
</details>

<details>
<summary><b>Do I need an Anthropic API key?</b></summary>

Not necessarily. autopod supports Anthropic API key, Claude MAX/PRO OAuth, OpenAI Codex, Azure Foundry, OpenRouter, and GitHub Copilot tokens. Set `modelProvider` on your profile.
</details>

<details>
<summary><b>Can I review before anything gets merged?</b></summary>

Use manual approval when you want to inspect every change. Autopod also supports configured auto-approval, subject to readiness and delivery guards. A validation pass is not itself approval or proof that a PR has merged. See [validation and readiness](validation.md#validation-pipeline).
</details>

<details>
<summary><b>Can I use this for non-web projects?</b></summary>

Yes. Set `hasWebUi: false` on the profile and lean on `lintCommand`, `sastCommand`, `buildCommand`, `testCommand`, command/API acceptance criteria, required facts, and AI task review. Browser smoke and web-ui AC checks are skipped when there is no frontend.
</details>

<details>
<summary><b>Can I use Azure DevOps instead of GitHub for PRs?</b></summary>

Yes. Set `prProvider: ado` on your profile; Git and REST authentication use the daemon host's Azure CLI or managed identity. autopod supports both `dev.azure.com` and `visualstudio.com` URL formats.
</details>

<details>
<summary><b>What are workspace pods for?</b></summary>

Workspace pods give you an interactive container (same image and setup as agent pods) without an AI agent. Use them to explore, prototype, or write acceptance criteria manually, then hand off to an automated agent with `--base-branch` and `--ac-from`. Think of it as the "prep" step before "exec".
</details>

<details>
<summary><b>Can agents use private npm/NuGet feeds?</b></summary>

Yes. Add `privateRegistries` to your profile with your Azure DevOps feed URLs and a `registryPat`. autopod generates `.npmrc` and `NuGet.config` files in the container at startup. The PAT is encrypted at rest.
</details>

<details>
<summary><b>Is there a desktop app?</b></summary>

Yes — `packages/desktop` is a native macOS app built with SwiftUI and AppKit. It gives you a three-column pod browser (sidebar → pod list → detail panel), Readiness/Evidence/Summary/Validation/Diff tabs, memory and scheduled-job management, analytics drill-downs, and a live terminal view (SwiftTerm). Build with Xcode. It connects to the same daemon as the CLI.
</details>

<details>
<summary><b>What happens if the daemon restarts mid-pod?</b></summary>

autopod recovers. On startup, the daemon scans for pods that were `provisioning` or `running` at shutdown and re-attaches to their containers. Work in progress is not lost — the agent resumes from where the container left off.
</details>

---

## Task token limits

Task token limits are opt-in: workflow and profile defaults are `null` (off).
Use `ap run --repo <repository> --task "..." --token-budget off` to override a
preset limit, or `--token-budget 500000` to choose a limit explicitly.
`ap budget <pod> off` removes an existing whole-task limit; a larger integer raises
it. Linked repair pods share that change. `--resume` also resumes a stopped native
Goal, while a running native Goal receives the new allowance without a restart.
These changes retain original launch settings, operator identity, and measured usage.
They do not reset counters or remove a separately configured reviewer sublimit.
Recorded aggregate tokens include input/context usage and are not a billing estimate.
Limits compare **budget-counted** tokens: recorded tokens with prompt-cache reads
counted at 0.1x (providers bill cache hits at about a tenth of input). Cache
creation, output and native Goal tokens count in full, so the counted figure never
exceeds the recorded total. Cache reads come from stored per-phase attribution;
where that split is absent (older or unreadable records) they count in full.
`ap status`, budget failures and refused resumes show both figures and the cache
reads, for example `Token budget exceeded (230000/200000 budget-counted tokens
used; 1500000 recorded incl. 1400000 cache reads at 0.1x)`.
Regular runtime limits are checked when usage is reported; they are not an exact
per-token provider spending cap. Hard-limited reviews still require settled usage;
with the default unlimited budget an active worker can request review normally.

Node24 worker release, real-image smoke checks, migration and rollback: [operator runbook](../node24-environments.md). Explicit Node22 templates remain available for compatibility.
