<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node-22-green?logo=node.js&logoColor=white" alt="Node 22">
  <img src="https://img.shields.io/badge/Fastify-5-black?logo=fastify&logoColor=white" alt="Fastify">
  <img src="https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/Azure-Container%20Apps-0078D4?logo=microsoft-azure&logoColor=white" alt="Azure">
</p>

# autopod

**Spec in, validated software out.**

autopod is an orchestration platform for AI coding agents. You describe a task, autopod spins up an isolated container, lets the agent work, validates the output in a real browser, and only bothers you when there's something worth reviewing. Run dozens of agents in parallel across repos, models, and runtimes — without babysitting a single one.

```
$ ap run my-app "Add a dark mode toggle to the settings page" --model opus

  Session a1b2c3d4 created (profile: my-app, model: opus)
  Provisioning container...
  Agent running...

  # Go grab coffee. Come back to a Teams notification with screenshots.
```

---

## Why autopod?

AI coding agents are powerful, but running them is still a pain. You set up the environment, watch the agent work, manually check the output, restart when it goes sideways, and pray it didn't break something unrelated.

autopod flips the model: **agents are untrusted by default.** They run in locked-down containers. When they say they're done, autopod doesn't take their word for it — it builds the project, starts it up, opens a real browser, takes screenshots, and asks a separate AI reviewer: *"Does this actually look right?"*

If it doesn't pass, the agent gets feedback and tries again. If it does pass, you get a notification with screenshots and a diff. One command to approve, and it's merged.

**The human stays in the loop. The human just doesn't have to do the boring part.**

---

## How It Works

```
                    +-----------+
                    |  ap run   |  You describe the task
                    +-----+-----+
                          |
                    +-----v-----+
                    |  Daemon    |  Orchestrates everything
                    +-----+-----+
                          |
              +-----------+-----------+
              |                       |
        +-----v-----+          +-----v-----+
        | Container  |          | Container  |  Isolated pods per task
        | (Agent)    |          | (Agent)    |
        +-----+-----+          +-----+-----+
              |                       |
        +-----v-----+          +-----v-----+
        | Validate   |          | Validate   |  Build, run, screenshot
        | (Playwright)|         | (Playwright)|
        +-----+-----+          +-----+-----+
              |                       |
        +-----v-----+          +-----v-----+
        | AI Review  |          | AI Review  |  "Does this match the task?"
        +-----+-----+          +-----+-----+
              |                       |
              +-----------+-----------+
                          |
                    +-----v-----+
                    | Notify    |  Screenshots + diff in Teams/CLI
                    +-----+-----+
                          |
                    +-----v-----+
                    | ap approve|  One command to merge
                    +-----------+
```

### Session Lifecycle

Every task follows a state machine:

```
queued --> provisioning --> running --> validating --> validated --> approved --> merging --> complete
                              |            |
                              |            +--> failed (retry with feedback, up to N attempts)
                              |
                              +--> awaiting_input (agent escalated — needs help)
```

- **Escalation** — Agents can ask a human, ask a cheaper AI model for a second opinion, or declare a blocker. The session pauses until someone responds via `ap tell`.
- **Correction loops** — If validation fails, the agent gets structured feedback (console errors, screenshot diffs, reviewer notes) and retries automatically. Up to 3 attempts by default, configurable per profile.
- **Self-validation** — Two-phase lifecycle inside the container: (1) agent works, (2) Playwright builds + runs + screenshots, then an AI reviewer judges the result against the original task.

---

## Features

- **Multi-agent parallelism** — Run 10, 20, 50 sessions across repos simultaneously
- **Self-validation** — Playwright smoke tests + AI task review before any human sees it
- **Model-agnostic** — Claude, Codex, or any runtime that speaks the protocol
- **Escalation via MCP** — Agents can pause and ask for help (human or AI)
- **Profile system** — Pre-configured templates per repo with inheritance
- **Image warming** — Pre-bake dependencies into Docker images for fast spin-up
- **Real-time TUI dashboard** — `ap watch` gives you a terminal UI with WebSocket updates
- **Teams notifications** — Rich Adaptive Cards with inline screenshots
- **Git-native** — Every session gets its own branch, PR created on approve
- **Correction loops** — Reject with feedback, agent retries from where it left off
- **On-demand previews** — `ap open <id>` spins up a live preview of any session's work
- **Session injection** — Plug in external MCP servers and CLAUDE.md content at daemon or profile level (e.g., Prism codebase context)

---

## Getting Started

### Prerequisites

- **Node.js 22+**
- **pnpm** (or use `npx pnpm` everywhere)
- **Docker** (for running agent containers locally)
- **Azure Entra ID app registration** (for auth — see [Auth Setup](#auth-setup))

### 1. Clone and install

```bash
git clone https://github.com/esbenwiberg/autopod.git
cd autopod
npx pnpm install
```

### 2. Build all packages

```bash
npx pnpm run build
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Required — from your Entra ID app registration
ENTRA_CLIENT_ID=<application-client-id>
ENTRA_TENANT_ID=<directory-tenant-id>

# For AI agents (in dev, set directly; in prod, use Key Vault)
ANTHROPIC_API_KEY=sk-ant-...

# For private repos
GITHUB_PAT=ghp_...

# Optional: Teams notifications
TEAMS_WEBHOOK_URL=https://prod-xx.westeurope.logic.azure.com/workflows/...
```

### 4. Start the daemon

**Option A: Docker Compose (recommended)**

```bash
docker compose up -d
```

Starts the daemon at `http://localhost:3100` with hot-reload on source changes.

**Option B: Run directly**

```bash
npx pnpm --filter @autopod/daemon run dev
```

### 5. Connect the CLI

```bash
# Point CLI at your daemon
ap connect http://localhost:3100

# Authenticate
ap login
```

### 6. Create your first profile

A profile tells autopod how to build, run, and validate a specific repo.

```bash
ap profile create my-app \
  --repo owner/my-app \
  --template node22-pw \
  --build "npm ci && npm run build" \
  --start "npm run preview -- --host 0.0.0.0 --port \$PORT" \
  --health "/" \
  --model opus
```

Available templates: `node22`, `node22-pw` (with Playwright/Chromium), `dotnet9`, `python312`, `custom`.

### 7. Run your first session

```bash
ap run my-app "Add a contact form to the about page with name, email, and message fields"
```

That's it. The agent will work, autopod will validate, and you'll be notified when it's ready.

### 8. Review and approve

```bash
# Check status
ap ls

# See what the agent did
ap diff a1b2c3d4

# Look at the screenshots
ap screenshots a1b2c3d4

# Happy? Ship it.
ap approve a1b2c3d4

# Not happy? Tell the agent what's wrong.
ap reject a1b2c3d4 "The form needs client-side validation"
```

---

## CLI Reference

### Authentication

```bash
ap login                     # Interactive login (Entra ID)
ap login --device            # Device code flow (headless/SSH)
ap logout                    # Clear credentials
ap whoami                    # Current user + daemon status
```

### Daemon

```bash
ap connect <url>             # Connect CLI to a daemon
ap disconnect                # Disconnect
ap daemon start --local      # Run daemon locally
ap daemon stop               # Stop local daemon
```

### Profiles

```bash
ap profile create <name>     # Create a new profile
ap profile ls                # List all profiles
ap profile show <name>       # Show profile details
ap profile edit <name>       # Open in $EDITOR
ap profile delete <name>     # Delete a profile
ap profile warm <name>       # Pre-bake deps into Docker image (faster spin-up)
```

### Sessions

```bash
# Create
ap run <profile> "<task>"                   # Start a session
ap run <profile> "<task>" --model opus      # Override model
ap run <profile> "<task>" --runtime codex   # Use Codex runtime
ap run <profile> "<task>" --branch feat/x   # Custom branch name
ap run <profile> "<task>" --no-validate     # Skip auto-validation

# Monitor
ap ls                                       # List sessions
ap ls --status running                      # Filter by status
ap ls --json                                # JSON output (for scripting)
ap status <id>                              # Full session details
ap logs <id>                                # Stream agent activity
ap logs <id> --build                        # Build/validation logs

# Interact
ap tell <id> "<message>"                    # Send message to agent
ap tell <id> --file instructions.md         # Message from file
ap tell <id> --stdin                        # Pipe from stdin

# Validate & Preview
ap validate <id>                            # Trigger validation manually
ap open <id>                                # Spin up live preview
ap screenshots <id>                         # Show screenshot URLs
ap diff <id>                                # Show git diff
ap diff <id> --stat                         # Diff summary only

# Complete
ap approve <id>                             # Create PR and merge
ap approve <id> --squash                    # Squash merge
ap reject <id> "<feedback>"                 # Reject — agent retries with your feedback
ap kill <id>                                # Kill session, discard work

# Bulk operations
ap approve --all-validated                  # Approve everything that passed
ap kill --all-failed                        # Clean up all failures
```

### Dashboard

```bash
ap watch                     # Launch TUI dashboard
```

Real-time session overview via WebSocket. Keyboard shortcuts:

| Key | Action |
|-----|--------|
| `Up/Down` | Navigate sessions |
| `t` | Tell (send message to agent) |
| `a` | Approve session |
| `r` | Reject with feedback |
| `d` | View diff |
| `l` | View logs |
| `o` | Open live preview |
| `x` | Kill session |
| `v` | Trigger validation |
| `q` | Quit |

---

## Profile Deep Dive

Profiles define how autopod handles a specific repository. They support **inheritance** — define a `frontend-base` profile and extend it per-app.

### Full options

```bash
ap profile create my-app \
  --repo owner/my-app \
  --branch main \
  --template node22-pw \
  --build "npm ci && npm run build" \
  --start "npm run preview -- --host 0.0.0.0 --port \$PORT" \
  --health "/" \
  --health-timeout 30000 \
  --model opus \
  --runtime claude \
  --max-validation-attempts 3 \
  --instructions "Use TypeScript. Prefer Tailwind CSS. Keep it accessible." \
  --extends frontend-base
```

### Validation pages

Configure which pages to validate and what to assert:

```yaml
validationPages:
  - path: "/"
    assertions:
      - selector: ".dark-mode-toggle"
        type: exists
      - selector: "h1"
        type: text_contains
        value: "Welcome"
  - path: "/about"
    assertions:
      - selector: ".contact-form"
        type: visible
```

Assertion types: `exists`, `visible`, `text_contains`, `count`.

### Escalation settings

Control how and when agents can ask for help:

```yaml
escalation:
  askHuman: true                  # Allow agent to pause and ask human
  askAi:
    enabled: true                 # Allow agent to ask cheaper model
    model: sonnet                 # Which model to consult
    maxCalls: 5                   # Max AI-to-AI escalations per session
  autoPauseAfter: 3              # Auto-escalate after N consecutive failures
  humanResponseTimeout: 3600000  # 1 hour before auto-killing stalled session
```

### Session Injection (MCP Servers & CLAUDE.md)

Profiles can inject additional MCP servers and CLAUDE.md content sections into agent sessions. This is how you plug in external tools (like [Prism](https://github.com/esbenwiberg/prism) for codebase context) without modifying autopod itself.

Injections work at two tiers with merge semantics:

```
Daemon config (defaults for all sessions)
    ↓ merge
Profile config (repo-specific overrides/additions)
    ↓ result
Session receives the merged set
```

Profile entries override daemon entries with the same key (`name` for MCP servers, `heading` for sections).

#### MCP servers

Add external MCP servers that agents can call at runtime:

```yaml
mcpServers:
  - name: prism
    url: "https://prism.internal/mcp"
    headers:
      Authorization: "Bearer ${PRISM_API_KEY}"
    description: "Codebase context powered by Prism. Use these tools to understand the codebase before making changes."
    toolHints:
      - "Call get_file_context before modifying any file"
      - "Call get_related_files to find blast radius of your changes"
      - "Call get_architecture_overview for system-level orientation"
```

#### CLAUDE.md sections

Inject content into the generated CLAUDE.md — either static or dynamically fetched at provisioning time:

```yaml
claudeMdSections:
  # Static section
  - heading: "Coding Standards"
    priority: 20
    content: "Always use TypeScript strict mode. Never use `any`."

  # Dynamic section — fetched from an API when the session starts
  - heading: "Codebase Architecture"
    priority: 10
    maxTokens: 4000
    fetch:
      url: "https://prism.internal/api/projects/org/my-app/context/arch"
      authorization: "Bearer prism_abc123"
      body: { "maxTokens": 4000 }
      timeoutMs: 10000
```

- **Priority** controls document order (lower = higher in CLAUDE.md, default: 50)
- **Dynamic sections** are fetched via POST at provisioning time; if the fetch fails, the section falls back to static `content` (if set) or is silently skipped
- **maxTokens** limits dynamic content length (~4 chars/token heuristic)

#### Daemon-level defaults

Set MCP servers and sections that apply to all sessions via environment variables:

```bash
DAEMON_MCP_SERVERS='[{"name":"prism","url":"https://prism.internal/mcp"}]'
DAEMON_CLAUDE_MD_SECTIONS='[{"heading":"Company Rules","content":"...","priority":5}]'
```

---

## Auth Setup

autopod uses Azure Entra ID for authentication.

1. Go to [Azure Portal](https://portal.azure.com) > **Entra ID** > **App registrations**
2. Create a new registration
3. Set redirect URI to `http://localhost` (for PKCE flow)
4. Enable **"Allow public client flows"** (for device code flow on headless machines)
5. Note the **Application (client) ID** and **Directory (tenant) ID**
6. Add them to your `.env`:

```bash
ENTRA_CLIENT_ID=<application-client-id>
ENTRA_TENANT_ID=<directory-tenant-id>
```

---

## Deployment (Azure)

autopod ships with full Azure infrastructure as code via Bicep.

### What gets deployed

| Resource | Purpose |
|----------|---------|
| **Container Apps Environment** | Runs the daemon + agent pods |
| **Container Registry (ACR)** | Stores Docker images |
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

CI/CD runs via GitHub Actions — see `.github/workflows/deploy.yml`.

---

## Development

### Project structure

```
autopod/
  packages/
    shared/            # Types, errors, constants — the contract between packages
    daemon/            # Fastify server, session orchestration, SQLite state
    cli/               # Commander CLI + Ink TUI dashboard
    escalation-mcp/    # MCP server injected into agent containers
    validator/         # Playwright smoke tests + AI task review
  infra/               # Azure Bicep IaC
  templates/           # Base Dockerfiles per stack
  plans/               # Architecture docs and implementation plans
```

### Commands

```bash
npx pnpm install              # Install all dependencies
npx pnpm run build            # Build all packages (via Turborepo)
npx pnpm run dev              # Watch mode
npx pnpm run test             # Run all tests (Vitest)
npx pnpm run lint             # Check with Biome
npx pnpm run lint:fix         # Auto-fix
```

### Run tests for a single package

```bash
npx pnpm --filter @autopod/cli exec npx vitest run
npx pnpm --filter @autopod/daemon exec npx vitest run
```

### Tech stack

| Tool | Why |
|------|-----|
| **TypeScript 5.9** | Type safety from CLI to daemon to container |
| **Fastify 5** | Fast, schema-validated HTTP + WebSocket |
| **SQLite** (better-sqlite3) | Zero-config embedded state, ACID transactions |
| **Ink** (React for terminals) | Rich TUI dashboard |
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

**Can I use models other than Claude?**
Yes. autopod supports multiple runtimes — set `--runtime codex` for OpenAI Codex, or implement a custom runtime adapter. The runtime interface is pluggable.

**Do I need Azure?**
For production, yes — autopod is built around Azure Container Apps, ACR, and Key Vault. For local development, Docker Compose is all you need.

**How much does it cost to run?**
Agent pods are ephemeral — they spin up, do work, and die. You only pay for compute while agents are active. The daemon itself is lightweight (single container, SQLite). The main cost driver is AI API usage, not infrastructure.

**What happens if the agent gets stuck?**
It can escalate via MCP tools: `ask_human` pauses and notifies you, `ask_ai` gets a second opinion from a cheaper model, `report_blocker` declares a hard stop. If the agent exceeds configured limits without completing, the session fails and you're notified.

**Can I review before anything gets merged?**
Always. Nothing merges without an explicit `ap approve`. The `validated` state means "autopod thinks it's good" — but you always have the final say.

**Can I use this for non-web projects?**
The validation layer (Playwright screenshots + AI review) is geared towards web apps. For non-web projects, use `--no-validate` to skip auto-validation and review diffs manually, or implement a custom validation engine.

---

## License

MIT

---

<p align="center">
  <sub>Built with mass amounts of mass-produced LLM tokens and mass-produced caffeine.</sub>
</p>
