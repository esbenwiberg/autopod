<p align="center">
  <img src="assets/banner.png" alt="autopod — Spec in. Validated software out." width="700">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node-22-green?logo=node.js&logoColor=white" alt="Node 22">
  <img src="https://img.shields.io/badge/Fastify-5-black?logo=fastify&logoColor=white" alt="Fastify">
  <img src="https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/Azure-Container%20Apps-0078D4?logo=microsoft-azure&logoColor=white" alt="Azure">
</p>

<p align="center">
  <b>Autonomous AI agent orchestration. Containerized. Validated. Human-approved.</b>
</p>

<p align="center">
  <a href="#getting-started">Getting Started</a> · <a href="#how-it-works">How It Works</a> · <a href="#cli-reference">CLI Reference</a> · <a href="#profile-deep-dive">Profile Config</a> · <a href="#deployment-azure">Deploy</a> · <a href="https://esbenwiberg.github.io/autopod">Docs ↗</a>
</p>

---

You describe a task. autopod spins up an isolated container, lets an AI agent work, validates the output in a real browser, and only bothers you when there's something worth reviewing. Run dozens of agents in parallel — across repos, models, and runtimes — without babysitting a single one.

```
$ ap run my-app "Add a dark mode toggle to the settings page" --model claude-opus-4-8

  Pod a1b2c3d4 created (profile: my-app, model: claude-opus-4-8)
  Provisioning container...
  Agent running...

  # Go grab coffee. Come back to a Teams notification with screenshots.
```

---

## Why autopod?

AI coding agents are powerful, but running them is still a pain. You set up the environment, watch the agent work, manually check the output, restart when it goes sideways, and pray it didn't break something unrelated.

autopod flips the model: **agents are untrusted by default.** They run in locked-down containers with network isolation and firewall rules. When they say they're done, autopod doesn't take their word for it — it builds the project, runs your test suite, starts it up, opens a real browser, takes screenshots, and asks a separate AI reviewer: *"Does this actually look right?"*

If it doesn't pass, the agent gets structured feedback and tries again. If it does, you get a notification with screenshots and a diff. One command to approve, and it's merged.

**The human stays in the loop. The human just doesn't have to do the boring part.**

---

## How It Works

```
                    ┌───────────┐
                    │  ap run   │  You describe the task
                    └─────┬─────┘
                          │
                    ┌─────▼─────┐
                    │  Daemon   │  Orchestrates everything
                    └─────┬─────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
        ┌─────▼─────┐ ┌──▼──┐ ┌─────▼─────┐
        │ Container  │ │ ... │ │ Container  │  Isolated pods per task
        │ (Agent)    │ │     │ │ (Agent)    │
        └─────┬─────┘ └──┬──┘ └─────┬─────┘
              │           │           │
        ┌─────▼─────┐    │     ┌─────▼─────┐
        │ Validate  │    │     │ Validate  │  Build → Test → Smoke → ACs → Review
        └─────┬─────┘    │     └─────┬─────┘
              │           │           │
        ┌─────▼─────┐    │     ┌─────▼─────┐
        │ AI Review │    │     │ AI Review │  "Does this match the task?"
        └─────┬─────┘    │     └─────┬─────┘
              │           │           │
              └───────────┼───────────┘
                          │
                    ┌─────▼─────┐
                    │  Notify   │  Screenshots + diff → Teams / CLI
                    └─────┬─────┘
                          │
                    ┌─────▼─────┐
                    │ ap approve│  One command to merge
                    └───────────┘
```

### Pod Lifecycle

Every task follows a state machine:

```
queued → provisioning → running → validating → validated → approved → merging → complete
                           │            │                                  ↓
                           │            └─→ failed (retry with feedback)  merge_pending
                           │                    │                              ↓
                           │                    └─→ review_required    fix pod spawned ←──────┐
                           │                           ├─→ running      (CI fail / review      │
                           │                           └─→ running       comments)             │
                           │                                             up to maxPrFixAttempts ┘
                           ├─→ paused (operator paused via ap pause / p key)
                           │      │
                           │      └─→ running (resumed via ap tell / nudge)
                           │
                           └─→ awaiting_input (agent escalated — needs help)

Any non-terminal state → killing → killed
```

**Fix pods** are spawned automatically when a pod's PR is blocked — by CI failures, failing checks, or `CHANGES_REQUESTED` review comments. The fix pod receives the original task plus sanitized failure summaries and reviewer notes, and pushes to the same branch. The cycle repeats up to `maxPrFixAttempts` (default: 3).

### Validation Pipeline

Validation is a multi-phase pipeline with two loops — each phase must pass before the next runs:

**Inner loop (agent self-validates):** While developing, the agent can use the `validate_in_browser` MCP tool to open a real browser in its container and verify work against acceptance criteria. This catches issues early, before the independent review.

**Outer loop (independent reviewer):**

| Phase | What happens | Configurable via |
|-------|-------------|------------------|
| **1. Setup** | Runs optional validation-time tooling setup before any checks | `profile.validationSetupCommand`, `profile.buildTimeout` |
| **2. Lint** | Runs optional static linting before build | `profile.lintCommand`, `profile.lintTimeout` |
| **3. SAST** | Runs optional security/static-analysis checks | `profile.sastCommand`, `profile.sastTimeout` |
| **4. Build** | Runs your build command inside the container | `profile.buildCommand`, `profile.buildTimeout` |
| **5. Test** | Runs your test suite (skipped if not configured) | `profile.testCommand`, `profile.testTimeout` |
| **6. Health check** | Starts the app and waits for HTTP 200 | `profile.startCommand`, `profile.healthPath` |
| **7. Smoke pages** | Playwright visits configured pages and checks assertions | `profile.smokePages` |
| **8. AC validation** | Classifies acceptance criteria as web/API/cmd/none and validates what can be executed | `pod.acceptanceCriteria` |
| **9. Required facts** | Runs contract-backed proof commands and checks declared artifacts | `pod.contract.requiredFacts` |
| **10. AI task review** | A separate model reviews the diff, task, contract, and prior findings | `profile.reviewerModel` |
| **11. Advisory browser QA** | Optional screenshot-backed AI browser pass that records evidence without changing validation outcome | `profile.pod.advisoryBrowserQaEnabled` |

Autopod computes the blocking validation decision from required phases. If any required phase fails, the agent gets structured feedback (setup output, console errors, build output, screenshot diffs, fact failures, AC failures, reviewer notes) and retries automatically. Advisory browser QA is stored as evidence for the operator and Readiness Review, not as a retry trigger. The AI reviewer receives tiered context: the diff, original task, contract, and findings from prior attempts.

Every validation attempt is stored with full results and **proof-of-work screenshots** — one per smoke page, AC browser check, and review screenshot. Screenshots are served from authenticated URLs like `GET /pods/:id/screenshots/:source/:filename`. Contract fact evidence is also exportable as `GET /pods/:id/validations/:attempt/evidence.yaml`.

After validation, the container is **stopped** (not removed). Launch an on-demand **preview** to interact with the agent's work in a real browser before approving.

Before approval, Autopod computes a compact **Readiness Review** snapshot from validation, security, action audit, network denials, advisory QA, scope, quality, and PR state. Automation only approves `ready` pods. Manual approval can proceed through `needs_review`; `risky` and `waived` approvals require a reason (`ap approve <id> --reason "..."`).

**When retries are exhausted** (`maxValidationAttempts` reached), the pod moves to `review_required` instead of just failing. From there you can:

- Grant more validation attempts from the desktop/API so the agent retries with accumulated feedback.
- Create a linked manual-fix workspace from the desktop/API, then re-validate.
- Reject from the CLI with `ap reject <id> "<feedback>"` to restart with your notes.

**Operator overrides:**

The daemon also supports interrupting in-flight validation and queueing per-finding validation overrides (`dismiss` or `guidance`) through the desktop/API. Overrides are persisted as auditable human decisions and merged into the next review pass.

---

## Features

<table>
<tr><td>🔀</td><td><b>Multi-agent parallelism</b></td><td>Run 10, 20, 50 pods across repos simultaneously</td></tr>
<tr><td>✅</td><td><b>Multi-phase validation</b></td><td>Setup → Lint → SAST → Build → Test → Health → Smoke → AC → Facts → AI review</td></tr>
<tr><td>🤖</td><td><b>Multi-runtime</b></td><td>Claude, Codex, or GitHub Copilot — swap with a flag</td></tr>
<tr><td>🔑</td><td><b>Multi-provider auth</b></td><td>Anthropic API, Claude MAX/PRO (OAuth), OpenAI Codex, Azure Foundry, OpenRouter, or Copilot tokens</td></tr>
<tr><td>🆘</td><td><b>Escalation via MCP</b></td><td>Agents can pause and ask for help (human or AI)</td></tr>
<tr><td>⏸️</td><td><b>Pause & nudge</b></td><td>Pause a running agent, send mid-flight instructions, resume without losing state</td></tr>
<tr><td>📋</td><td><b>Agent plan & progress</b></td><td>Agents report their implementation plan and phase progress in real time</td></tr>
<tr><td>🛡️</td><td><b>Action control plane</b></td><td>Read GitHub issues, ADO work items, and app logs — with PII stripping and prompt-injection quarantine</td></tr>
<tr><td>📦</td><td><b>Profile system</b></td><td>Pre-configured templates per repo with inheritance</td></tr>
<tr><td>🐳</td><td><b>Image warming</b></td><td>Pre-bake dependencies into Docker images for fast spin-up</td></tr>
<tr><td>💬</td><td><b>Teams notifications</b></td><td>Rich Adaptive Cards with inline screenshots</td></tr>
<tr><td>🔄</td><td><b>Correction loops</b></td><td>Reject with feedback, agent retries from where it left off</td></tr>
<tr><td>🌐</td><td><b>On-demand previews</b></td><td><code>ap open &lt;id&gt;</code> spins up a live preview of any pod's work</td></tr>
<tr><td>🔌</td><td><b>Pod injection</b></td><td>Plug in external MCP servers and CLAUDE.md content at daemon or profile level</td></tr>
<tr><td>🏗️</td><td><b>Git-native PRs</b></td><td>GitHub and Azure DevOps — every pod gets its own branch</td></tr>
<tr><td>🧪</td><td><b>Workspace pods</b></td><td>Interactive containers for manual prep, then hand off to automated agents</td></tr>
<tr><td>🔐</td><td><b>Private registries</b></td><td>npm and NuGet feeds from Azure DevOps — credentials injected automatically</td></tr>
<tr><td>⚡</td><td><b>Skills injection</b></td><td>Custom slash commands from local files or GitHub repos, injected into agent containers</td></tr>
<tr><td>🖥️</td><td><b>macOS desktop app</b></td><td>Native SwiftUI app for pod monitoring — readiness, evidence, grouped diffs, validation, memory, analytics, and live terminal views</td></tr>
<tr><td>♻️</td><td><b>Pod recovery</b></td><td>Daemon auto-recovers in-flight pods on restart — no lost work on redeploy</td></tr>
<tr><td>💡</td><td><b>Liveness heartbeat</b></td><td>Green/yellow/red dot per pod — spot stalled agents at a glance in desktop</td></tr>
<tr><td>🧠</td><td><b>Daemon-curated memory</b></td><td>Reviewer-model extraction suggests durable knowledge; humans approve, and approved content is injected into matching future pods</td></tr>
<tr><td>🔁</td><td><b>Validation interrupt & overrides</b></td><td>Interrupt in-flight validation, dismiss recurring false-positive findings, queue per-finding guidance</td></tr>
<tr><td>🧭</td><td><b>Readiness Review</b></td><td>Approval summary across validation, security, network, action audit, scope, quality, advisory QA, and PR state</td></tr>
<tr><td>👀</td><td><b>Advisory browser QA</b></td><td>Optional screenshot-backed AI browser review that adds evidence without turning soft concerns into blockers</td></tr>
<tr><td>⚡</td><td><b>Azure PIM activation</b></td><td>Workspace pods can activate Azure PIM groups for elevated access — auto-deactivated when the pod ends</td></tr>
<tr><td>📜</td><td><b>History analysis workspace</b></td><td><code>ap history</code> creates a workspace pre-loaded with pod history data for pattern analysis</td></tr>
<tr><td>📌</td><td><b>Profile versioning</b></td><td>Every profile update auto-increments a version counter; pods snapshot the exact profile used at creation</td></tr>
<tr><td>☁️</td><td><b>Local or cloud containers</b></td><td>Run agent pods on local Docker or Azure Container Instances — swap with <code>executionTarget</code> on the profile</td></tr>
<tr><td>📅</td><td><b>Scheduled jobs</b></td><td>Cron-triggered pods with reusable prompt templates and per-run field overrides</td></tr>
<tr><td>🔗</td><td><b>Series workflows</b></td><td>Multi-pod DAGs with dependency chains and three PR modes: single branch, stacked, or none</td></tr>
<tr><td>🏷️</td><td><b>Issue watcher</b></td><td>Label a GitHub or ADO issue — autopod spawns a pod, posts progress comments, and updates labels automatically</td></tr>
<tr><td>📊</td><td><b>Analytics dashboard</b></td><td>Fleet metrics: cost by phase/model, memory effectiveness, first-pass rate, throughput, safety events, quality scores</td></tr>
<tr><td>🔧</td><td><b>Auto fix pods</b></td><td>On CI failure or review comments, the daemon spawns a fix pod with sanitized feedback — up to <code>maxPrFixAttempts</code></td></tr>
<tr><td>📸</td><td><b>Proof-of-work evidence</b></td><td>Validation captures screenshots and contract fact evidence per attempt — smoke, AC, facts, and review</td></tr>
<tr><td>📱</td><td><b>Mobile control PWA</b></td><td>Tailscale-served phone inbox for needs-me pods, escalations, validation summaries, and approve/reject/kill/nudge actions</td></tr>
<tr><td>🧾</td><td><b>Grouped evidence views</b></td><td>Desktop/API surfaces grouped diffs, per-pod cost buckets, firewall denials, and action audit chains</td></tr>
</table>

---

## Getting Started

## Install

Install dependencies with pnpm through `npx`:

```bash
npx pnpm install
```

## Usage

Create or select a profile, then start a pod with `ap run`:

```bash
ap run my-app "Add a dark mode toggle to the settings page"
```

## Build

Build every workspace package through Turbo:

```bash
npx pnpm build
```

## Test

Run the full Vitest suite:

```bash
npx pnpm test
```

## Architecture

Autopod is a pnpm/Turbo monorepo. `packages/shared` owns the type contracts,
`packages/daemon` runs the Fastify API and pod orchestration loop,
`packages/cli` exposes the `ap` command, `packages/validator` builds
browser-validation scripts, `packages/escalation-mcp` is injected into
agent containers for escalation and self-validation tools, and
`packages/mobile-web` builds the phone PWA served by the daemon at `/mobile/*`.

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
# Optional when your app exposes a non-default App ID URI.
# Defaults to api://<application-client-id>, client ID, and api://autopod.
ENTRA_AUDIENCE=api://<application-client-id>

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
ap profile create
```

The command opens `$EDITOR` with a YAML template. A minimal repo-backed profile
looks like this:

```yaml
name: my-app
repoUrl: https://github.com/owner/my-app.git
defaultBranch: main
template: node22-pw
buildCommand: npm ci && npm run build
validationSetupCommand: null
testCommand: npm test
startCommand: npm run preview -- --host 0.0.0.0 --port $PORT
healthPath: /
smokePages:
  - path: /
maxValidationAttempts: 3
defaultRuntime: claude
defaultModel: claude-opus-4-8
reviewerModel: claude-sonnet-4-6
```

Available templates:

| Template | Stack | Includes |
|----------|-------|----------|
| `node22` | Node.js 22 | npm/pnpm/yarn |
| `node22-pw` | Node.js 22 + Playwright | Chromium for browser validation |
| `dotnet9` | .NET 9 SDK | dotnet CLI |
| `dotnet10` | .NET 10 + Node.js 22 | Mixed stacks (dotnet + npm/pnpm/yarn) |
| `dotnet10-go` | .NET 10 + Node.js 22 + Go 1.24 | Dagger-in-Go pipelines against .NET projects (Dagger CLI + SDK pre-cached) |
| `python312` | Python 3.12 | pip/poetry |
| `python-node` | Python 3.12 + Node.js 22 | Full-stack Python/JS |
| `python-node-pg` | Python 3.12 + Node.js 22 + PostgreSQL | Full-stack with Postgres client |
| `go124` | Go 1.24 | Go toolchain |
| `go124-pw` | Go 1.24 + Playwright | Go with Chromium for browser validation |
| `custom` | Bring your own | Custom Dockerfile |

### 7. Run your first pod

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

# Inspect validation evidence
ap status a1b2c3d4

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
ap profile auth <name>       # Interactive Claude MAX/PRO OAuth setup
ap profile auth-openai <n>   # Interactive OpenAI Codex ChatGPT/Pro auth setup
ap profile auth-copilot <n>  # Interactive Copilot OAuth setup
ap profile env-set <n> KEY=VALUE  # Add validation-time env vars
ap profile env-unset <n> KEY      # Remove validation-time env vars

# Per-action approval overrides (fine-tune which actions require human sign-off)
ap profile action-override list <name>
ap profile action-override set <name> <action> --approval
ap profile action-override remove <name> <action>
```

### Pods

```bash
# Create
ap run <profile> "<task>"                   # Start a pod
ap run <profile> "<task>" --model claude-opus-4-8  # Override model
ap run <profile> "<task>" --runtime codex   # Use Codex runtime
ap run <profile> "<task>" --runtime copilot # Use Copilot runtime
ap run <profile> "<task>" --branch feat/x   # Custom branch name
ap run <profile> "<task>" --skip-validation # Skip auto-validation
ap run <profile> "<task>" --base-branch feat/plan  # Branch from a specific base (e.g. workspace output)
ap run <profile> "<task>" --ac-from specs/ac.md    # Load acceptance criteria from a file in the repo
ap run <profile> "<task>" --sidecar dagger          # Request a configured sidecar
ap run <profile> "<task>" --ref-repo https://github.com/org/repo.git
ap run <profile> "<task>" --ref-from-profile docs-repo

# Monitor
ap ls                                       # List pods
ap ls --status running                      # Filter by status
ap ls --json                                # JSON output (for scripting)
ap status <id>                              # Full pod details
ap logs <id>                                # Stream agent activity
ap logs <id> --build                        # Build/validation logs

# Interact
ap tell <id> "<message>"                    # Send message (also resumes paused pods)
ap tell <id> --file instructions.md         # Message from file
ap tell <id> --stdin                        # Pipe from stdin
ap pause <id>                               # Pause a running pod
ap nudge <id> "<message>"                   # Send nudge (agent picks up async)

# Validate & Preview
ap validate <id>                            # Trigger validation manually
ap open <id>                                # Open the pod's current preview URL, if one is available
ap diff <id>                                # Show the last validation diff
ap update-from-base <id>                    # Rebase pod branch onto latest base and restart validation
ap kick <id> --reason "stuck"               # Re-enqueue a stuck queued pod or free a stuck slot

# Complete
ap approve <id>                             # Create PR and merge
ap approve <id> --squash                    # Squash merge
ap approve <id> --reason "reviewed risk"    # Required for risky/waived readiness approvals
ap reject <id> "<feedback>"                 # Reject — agent retries with your feedback
ap kill <id>                                # Kill pod, discard work

# Bulk operations
ap approve --all-validated                  # Approve everything that passed
ap kill --all-failed                        # Clean up all failures

# Stats
ap stats                                    # Aggregate counts by status, avg duration, total cost
```

### Spec Utilities

```bash
ap spec check specs/my-feature              # Validate a spec folder locally
ap pod create <profile> --spec specs/task   # Create one pod from brief.md + contract.yaml
                                             # Spec files are available at /autopod/spec
ap pod create <profile> --spec specs/task --include-specs
                                             # Also commit spec files onto the pod branch
```

`contract.yml` is accepted as an alias for `contract.yaml`; if both exist in the
same spec folder, Autopod errors instead of guessing. `ap series create` exposes
the spec folder as runtime context for every pod by default and has the same
`--include-specs` flag for root pods when the agent should carry the local spec
folder into its branch.

### Mobile Control

```bash
ap mobile serve-instructions                # Print one-time Tailscale Serve setup
ap mobile pair                              # Print a QR code for pairing the phone PWA
ap mobile pair --host mymac.tailnet.ts.net  # Override detected MagicDNS host
```

### Workspace Pods

```bash
ap workspace <profile> [description]        # Spin up an interactive container (no agent)
ap workspace <profile> -b feat/plan-auth    # With explicit branch name
ap workspace <profile> --pim-group <spec>   # Activate PIM group on pod start
ap attach <id>                              # Shell into a workspace pod (auto-pushes on exit)
```

### History Analysis

```bash
ap history <profile>              # Create a workspace pre-loaded with pod history data
ap history <profile> --since 7d   # Filter by recency (e.g. 7d, 30d, 2w)
ap history <profile> --failures   # Only include failed/review_required pods
ap history <profile> --limit 50   # Max pods to load (default: 100)
```

The history workspace gets a SQLite database of past pods — events, validation results, escalations, costs — mounted at `/workspace/history.db`. Use it with an AI agent to analyse patterns: recurring failures, common blockers, token waste.

### Memories

Memory management is exposed through the desktop app and REST API:

```http
GET    /memory
POST   /memory
GET    /memory/candidates?status=pending
PATCH  /memory/candidates/:id
GET    /memory/:id/usage
GET    /memory/:id/source-evidence
GET    /memory/:id/stale-evidence
PATCH  /memory/:id
DELETE /memory/:id
```

### Series

Series run multiple pods in dependency order — useful for breaking large features into a DAG of focused tasks.

```bash
ap series create <spec-folder>              # Create series from a briefs/ spec folder
  --profile <name>                          # Profile for all pods (required)
  --pr-mode single|stacked|none             # single: one shared branch+PR; stacked: one PR per pod; none: branches only
  --base-branch <branch>                    # Override base branch
  --series-name <name>                      # Override series name (default: derived from folder)

ap series status <series-id>               # Status of all pods + cost rollup
```

**Brief layout** (one folder per pod in `briefs/`):

```
specs/auth-rewrite/
  purpose.md
  design.md
  briefs/
    01-schema/
      brief.md
      contract.yaml
    02-routes/
      brief.md
      contract.yaml
```

`brief.md` carries task text and advisory scope:

```md
---
touches:
  - "src/auth/"
does_not_touch:
  - "src/admin/"
context_files:
  - "docs/oauth-spec.md"
---

## Task

Add `/auth/login` and `/auth/callback` endpoints per the spec.
```

`contract.yaml` carries dependencies and executable proof:

```yaml
contract_version: 1
title: "Implement OAuth routes"
depends_on:
  - "Schema migration"
scenarios:
  - id: oauth-routes
    given:
      - "the API server is running"
    when:
      - "the user visits /auth/login"
    then:
      - "the login route responds without server errors"
required_facts:
  - id: fact-oauth-routes-test
    proves: ["oauth-routes"]
    kind: integration-test
    artifact:
      path: "packages/daemon/src/auth/oauth-routes.test.ts"
      change: create
    command: "npx pnpm --filter @autopod/daemon test -- oauth-routes"
human_review: []
```

Add `purpose.md` and `design.md` at the spec root for context injected into every pod's CLAUDE.md. The full spec folder is also mounted read-only at `/autopod/spec`, while series handovers live at `/autopod/artifacts/handovers`. Brief frontmatter `acceptance_criteria` and markdown `## Acceptance Criteria` sections are no longer accepted for runnable specs; use `contract.yaml` scenarios, required facts, and human review items instead.

### Scheduled Jobs

Run pods on a cron schedule — nightly security audits, weekly dependency upgrades, recurring regressions. Jobs can either carry a literal task or reference a reusable prompt template with per-job field values.

```bash
ap schedule create <profile> <name> <cron> <task>
  # Example: ap schedule create my-app "nightly-audit" "0 2 * * *" "Run security audit on main branch"

ap schedule template create <name> <prompt>     # Reusable prompt template
ap schedule template list [--json]
ap schedule template show <id>
ap schedule template edit <id> --prompt <text>
ap schedule template delete <id>

ap schedule create <profile> <cron> --template <id-or-name>
ap schedule create <profile> <cron> --template <id-or-name> --set area=frontend
ap schedule edit <id> --template <id-or-name> --set area=backend

ap schedule list [--json]                  # List all jobs with next-run ETA
ap schedule show <id>                      # Job details (cron, next run, last run, task)
ap schedule edit <id> --cron "0 9 * * 1"   # Edit profile/cron/template/overrides/enabled
ap schedule enable <id>                    # Re-enable a disabled job
ap schedule disable <id>                   # Pause without deleting
ap schedule delete <id>                    # Delete a job
ap schedule run <id>                       # Trigger immediately (ignores schedule)
ap schedule catchup                        # Interactive: review missed runs, run or skip each
```

When the daemon restarts mid-window, `catchupPending` is set on any missed job. Use `ap schedule catchup` to review and decide.

---

## Profile Deep Dive

Profiles define how autopod handles a specific repository. They support **inheritance** — define a `frontend-base` profile and extend it per-app.

### Full options

Create and edit profiles through YAML:

```bash
ap profile create
ap profile edit my-app
```

Common fields:

```yaml
name: my-app
repoUrl: https://github.com/owner/my-app.git
defaultBranch: main
extends: frontend-base
template: node22-pw
buildWorkDir: null
validationSetupCommand: npm ci
lintCommand: npx pnpm lint
sastCommand: semgrep --config=p/security-audit .
buildCommand: npx pnpm build
testCommand: npx pnpm test
startCommand: npx pnpm preview -- --host 0.0.0.0 --port $PORT
healthPath: /
healthTimeout: 120
smokePages:
  - path: /
maxValidationAttempts: 3
defaultRuntime: claude
defaultModel: claude-opus-4-8
reviewerModel: claude-sonnet-4-6
modelProvider: anthropic
prProvider: github
containerMemoryGb: 4
buildEnv:
  NODE_OPTIONS: --max-old-space-size=4096
skipValidationPhases: [] # setup|lint|sast|build|test|health|pages|facts|review|advisory
hasWebUi: true
agentDonePrompt: null
branchPrefix: autopod/
executionTarget: local # local|sandbox
workerProfile: my-app
pod:
  advisoryBrowserQaEnabled: false
```

### PR providers

autopod supports creating pull requests on both GitHub and Azure DevOps:

```yaml
# GitHub (default)
prProvider: github

# Azure DevOps
prProvider: ado
adoPat: <your-ado-personal-access-token>  # encrypted at rest
```

ADO supports both URL formats:
- `https://dev.azure.com/{org}/{project}/_git/{repo}`
- `https://{org}.visualstudio.com/{project}/_git/{repo}`

### Smoke pages

Configure baseline pages to check on every validation run (infrastructure-level sanity):

```yaml
smokePages:
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

### Acceptance criteria

For task-specific validation, pass acceptance criteria from a file when creating a pod:

```bash
ap run my-app "Add dark mode" \
  --ac-from specs/dark-mode-ac.md
```

The AC file format is one criterion per line, with optional `- ` prefixes and blank lines ignored:

```md
- Settings page has a dark mode toggle
- Toggle persists after page refresh
- Dark mode applies to all pages
```

The validation engine classifies criteria as web, API, command, or reviewer-owned checks. Web criteria use a real browser and screenshots; command/API criteria can run deterministically; reviewer-owned criteria are checked by the AI task reviewer. The agent also has access to a `validate_in_browser` MCP tool for self-checking during development.

For runnable specs created by `/prep` or `/plan-feature`, put executable proof in `contract.yaml` (`scenarios`, `required_facts`, and optional `human_review`) rather than brief frontmatter ACs. Required facts run during validation and produce attempt-scoped evidence YAML.

### Validation commands

Add deterministic checks to the validation pipeline:

```yaml
validationSetupCommand: "uv pip install ruff mypy semgrep"
lintCommand: "npx pnpm lint"
sastCommand: "semgrep --config=p/security-audit ."
testCommand: "npm test"
buildEnv:
  NODE_OPTIONS: "--max-old-space-size=4096"
```

Setup runs first when configured and uses `buildTimeout`. Lint and SAST run before build. Tests run after build and before health/browser checks. If a deterministic phase fails, downstream phases are skipped for that attempt; the agent receives stdout/stderr output as feedback and retries.

`validationSetupCommand` is for validation-time tooling, not the agent runtime. Use it for commands like installing `ruff`, `mypy`, Semgrep rules, browser-test dependencies, or repo-specific harness packages that lint/SAST/test need before the app build runs.

### Advisory browser QA

Advisory browser QA is optional, screenshot-backed evidence for the approval decision:

```yaml
pod:
  advisoryBrowserQaEnabled: true
```

When enabled, Autopod keeps the preview/container alive long enough for a separate reviewer to inspect the running app. Findings are persisted into validation history and Readiness Review, but they do not flip validation from pass to fail by themselves.

### Private Registries

If your project pulls packages from private Azure DevOps feeds, autopod can inject the right auth config into containers automatically.

```yaml
privateRegistries:
  # npm feed (scoped or unscoped)
  - type: npm
    url: "https://pkgs.dev.azure.com/{org}/_packaging/{feed}/npm/registry/"
    scope: "@myorg"          # optional — for scoped packages

  # NuGet feed
  - type: nuget
    url: "https://pkgs.dev.azure.com/{org}/_packaging/{feed}/nuget/v3/index.json"

# PAT for authenticating (encrypted at rest)
registryPat: "<your-ado-pat>"
registryPatExpiresAt: "2026-12-31"  # optional YYYY-MM-DD expiry metadata
```

At pod startup, autopod generates `.npmrc` and/or `NuGet.config` files in the container workspace with embedded auth tokens. Child profiles inherit and merge registries from parent profiles (deduped by URL). If a configured GitHub, ADO, or registry PAT has an expiry date in the past, pod creation is blocked with `PAT_EXPIRED` so the agent does not burn time on known-bad credentials.

### Network Policy

Control egress traffic from agent containers. Disabled by default.

```yaml
networkPolicy:
  enabled: true

  # Mode controls the firewall behaviour:
  #   restricted  — (default) only allowedHosts are reachable via SNI proxy
  #   deny-all    — block everything except loopback and DNS
  #   allow-all   — no outbound restrictions (useful for debug)
  mode: restricted

  # Hosts to allow. Wildcards match on SNI suffix.
  allowedHosts:
    - "api.stripe.com"
    - "*.my-company.com"

  # Replace the built-in defaults (Anthropic, npm, GitHub, etc.) entirely.
  # Use this when you need a strict allowlist with no implicit hosts.
  replaceDefaults: false

  # Shorthand: automatically add all common package manager hosts.
  # Covers npm, yarn, pypi, crates.io, nuget, golang, rubygems, debian apt, etc.
  allowPackageManagers: true
```

**How `restricted` mode works — HAProxy SNI proxy:**

In `restricted` mode, iptables NAT redirects outbound port 443 to an HAProxy instance running on loopback inside the container. HAProxy reads the TLS ClientHello SNI field, checks it against the allowlist, then splices the raw TLS bytes through to the real host — no MITM, no certificate substitution. Denied connections are logged and counted as safety events. Port 80 follows the same pattern for HTTP. DNS (UDP/TCP 53) is always allowed in all modes.

This means egress policy is enforced at the hostname level even for HTTPS, without breaking TLS.

**Built-in default hosts** (always allowed unless `replaceDefaults: true`):

`api.anthropic.com`, `api.openai.com`, `registry.npmjs.org`, `pypi.org`, NuGet hosts, Azure CDN hosts, `pkgs.dev.azure.com`, `platform.claude.com`, and GitHub Copilot endpoints. `github.com` / `raw.githubusercontent.com` are intentionally not on the default list; add them explicitly only for profiles that need direct GitHub egress (for example, GitHub-hosted package dependencies).

**Live updates** — patching a profile's `networkPolicy` via the API immediately re-applies firewall rules to all running containers using that profile. No restart needed.

**MCP server hosts** are always allowed regardless of mode — the daemon injects them automatically.

### Escalation settings

Control how and when agents can ask for help:

```yaml
reviewerModel: claude-sonnet-4-6 # Model used by ask_ai and AI task review
escalation:
  askHuman: true                  # Allow agent to pause and ask human
  askAi:
    enabled: true                 # Allow agent to ask cheaper model
    model: claude-sonnet-4-6      # Legacy wire compatibility; reviewerModel is authoritative
    maxCalls: 5                   # Max AI-to-AI escalations per pod
  autoPauseAfter: 3              # Auto-escalate after N consecutive failures
  humanResponseTimeout: 3600000  # 1 hour before auto-killing stalled pod
```

> **Note:** `ask_ai` and the AI task review use `profile.reviewerModel`. `escalation.askAi.model` is retained only as a legacy wire-compatibility field.

### Multi-Provider Model Auth

Profiles can authenticate with different AI providers:

| Provider | Auth method | Use case |
|----------|-------------|----------|
| `anthropic` | API key (`ANTHROPIC_API_KEY`) | Default — direct Anthropic API |
| `max` | OAuth (access + refresh tokens) | Claude MAX/PRO consumer subscriptions |
| `openai` | `OPENAI_API_KEY` or `ap profile auth-openai` ChatGPT/Pro auth | Codex runtime with OpenAI models |
| `foundry` | Managed identity/API key + project config | Azure-hosted Foundry deployments; Anthropic-compatible or OpenAI-compatible surface |
| `copilot` | GitHub token (OAuth / fine-grained PAT) | GitHub Copilot runtime |
| `openrouter` | OpenRouter API key | Experimental Codex runtime routing through OpenRouter-compatible model IDs |

```yaml
# Set on profile
modelProvider: max          # anthropic | max | openai | foundry | copilot | openrouter

# Foundry-specific
providerCredentials:
  provider: foundry
  endpoint: "https://your-foundry.azure.com"
  projectId: "my-project"
  apiSurface: openai # optional; defaults to anthropic

# OpenRouter-specific
modelProvider: openrouter
openrouterApiKey: "sk-or-..."
defaultRuntime: codex
defaultModel: "provider/model"
```

For **MAX/PRO**, the daemon handles OAuth token lifecycle automatically — pre-flight refresh before pod start, post-pod persistence of rotated tokens.

For **OpenAI Codex**, use `ap profile auth-openai <name>` for interactive ChatGPT/Pro login, or rely on `OPENAI_API_KEY` for API-key auth. Codex profiles should use `defaultRuntime: codex`.

For **Copilot**, use `ap profile auth-copilot <name>` for interactive OAuth setup. Supported token types: OAuth (`gho_`), fine-grained PAT (`github_pat_`), and GitHub App (`ghu_`). Classic PATs (`ghp_`) are not supported.

### Daemon GitHub identity

All GitHub-backed profiles use the single GitHub identity authenticated through `gh` as the
account that runs the daemon. For a host-installed daemon service, run:

```bash
sudo -u <daemon-user> gh auth login --hostname github.com --git-protocol https
```

For the supported Docker Compose deployment, `gh` is installed in the daemon image and its
configuration is retained in the restricted `daemon-gh-config` volume. Authenticate that exact
container identity instead:

```bash
docker compose exec daemon gh auth login --hostname github.com --git-protocol https
```

For another container orchestrator, mount a persistent, daemon-user-only directory at the
runtime user's GitHub CLI config path (`/home/autopod/.config/gh` in the production image), then
run the login command inside the running container. Authenticating only the host account does not
make its GitHub CLI state available inside a container.

Use a dedicated, lower-privilege development account and restrict its repository permissions.
Autopod resolves its credential explicitly for host Git, PRs, brokered GitHub actions, issue
watchers, private reference repositories, warm images, and requested workspace injection; it does
not enable ambient Git credential helpers or automatically inject the credential into pods.
Legacy profile `githubPat` fields remain accepted and encrypted for rolling-client compatibility
and rollback, but are redacted, ignored operationally, and never mask missing daemon `gh` auth.
`COPILOT_GITHUB_TOKEN` remains a separate model-provider credential.

### Pod Injection (MCP Servers & CLAUDE.md)

Profiles can inject additional MCP servers and CLAUDE.md content sections into agent pods. This is how you plug in external tools (like [Prism](https://github.com/esbenwiberg/prism) for codebase context) without modifying autopod itself.

Injections work at two tiers with merge semantics:

```
Daemon config (defaults for all pods)
    ↓ merge
Profile config (repo-specific overrides/additions)
    ↓ result
Pod receives the merged set
```

Profile entries override daemon entries with the same key (`name` for MCP servers, `heading` for sections).

#### MCP servers

```yaml
mcpServers:
  - name: prism
    url: "https://prism.internal/mcp"
    headers:
      Authorization: "Bearer ${PRISM_API_KEY}"
    description: "Codebase context powered by Prism."
    toolHints:
      - "Call get_file_context before modifying any file"
      - "Call get_related_files to find blast radius of your changes"
```

#### CLAUDE.md sections

```yaml
claudeMdSections:
  # Static section
  - heading: "Coding Standards"
    priority: 20
    content: "Always use TypeScript strict mode. Never use `any`."

  # Dynamic section — fetched from an API when the pod starts
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
- **Dynamic sections** are fetched via POST at provisioning time; if the fetch fails, the section falls back to static `content` or is silently skipped
- **maxTokens** limits dynamic content length (~4 chars/token heuristic)

#### Daemon-level defaults

Set MCP servers and sections that apply to all pods via environment variables:

```bash
DAEMON_MCP_SERVERS='[{"name":"prism","url":"https://prism.internal/mcp"}]'
DAEMON_CLAUDE_MD_SECTIONS='[{"heading":"Company Rules","content":"...","priority":5}]'
```

### Skills Injection

Inject custom slash commands into agent containers from local files or GitHub repos. Skills are markdown files that become available as `/commands` inside the agent's Claude session.

```yaml
skills:
  # Local skill — read from daemon host filesystem
  - name: review
    description: "Run a structured code review"
    source:
      type: local
      path: /opt/skills/review.md

  # GitHub skill — fetched from a repo at provisioning time
  - name: security-check
    description: "OWASP-aware security review"
    source:
      type: github
      repo: myorg/claude-skills
      path: security-check.md       # defaults to {name}.md
      ref: main                      # branch, tag, or SHA (default: main)
      token: "${GITHUB_TOKEN}"       # optional, for private repos
```

Skills merge the same way as MCP servers and CLAUDE.md sections: daemon-level defaults + profile-level overrides (matched by `name`). Failed skill resolutions (missing file, GitHub 404) are logged but don't block provisioning.

### Workspace Pods (Prep → Exec Handoff)

Workspace pods are interactive containers with no agent — same image, network, and credentials as agent pods, but you drive. Use them to explore, prototype, or write specs manually, then hand off to an automated agent that branches from your work.

```
main
  └── feat/plan-auth           ← workspace pod: you edit here, pushes on exit
        └── autopod/abc123     ← worker pod: --base-branch feat/plan-auth
                                              --ac-from specs/acceptance-criteria.md
```

**Workflow:**

```bash
# 1. Spin up a workspace
ap workspace my-app "Plan auth rewrite" -b feat/plan-auth

# 2. Shell in and do your thing
ap attach <id>
# ... edit files, write specs, prototype ...
# Exit the shell — branch auto-pushes to origin

# 3. Hand off to an agent, branching from your work
ap run my-app "Implement auth rewrite per spec" \
  --base-branch feat/plan-auth \
  --ac-from specs/acceptance-criteria.md
```

**AC file format** (`--ac-from`): one criterion per line, optional `- ` prefix, blank lines ignored.

```
- Login page renders email and password fields
- Invalid credentials show an error banner
- Successful login redirects to /dashboard
```

### Action Control Plane

Agents often need context from external systems — GitHub issues, Azure DevOps work items, application logs. The action control plane lets agents call these APIs in a controlled, sandboxed way.

```
Agent calls MCP tool (e.g. read_issue)
    → Daemon validates request against action policy
    → Backend handler executes (GitHub API, ADO, Azure Logs, generic HTTP)
    → Response pipeline:
        1. Prompt injection quarantine (score-based: block / warn / pass)
        2. PII sanitization (emails, API keys, AWS/Azure keys, IPs)
        3. Field whitelist (only configured fields pass through)
    → Clean result returned to agent
```

#### Built-in actions

| Group | Actions |
|-------|---------|
| **GitHub Issues** | `read_issue`, `search_issues`, `read_issue_comments` |
| **GitHub PRs** | `read_pr`, `read_pr_comments`, `read_pr_diff` |
| **GitHub Code** | `read_file`, `search_code` |
| **Azure DevOps Work Items** | `read_workitem`, `search_workitems` |
| **Azure DevOps PRs** | `ado_read_pr`, `ado_read_pr_threads`, `ado_read_pr_changes` |
| **Azure DevOps Code** | `ado_read_file`, `ado_search_code` |
| **Azure Logs** | `query_logs`, `read_app_insights`, `read_container_logs` |
| **Azure PIM** | `activate_pim_group`, `deactivate_pim_group`, `list_pim_activations` |

#### Configuration

```yaml
actionPolicy:
  enabledGroups:
    - github-issues
    - github-prs
    - ado-workitems
  sanitization:
    preset: standard          # standard | strict | relaxed
  quarantine:
    enabled: true
    threshold: 0.5            # ≥0.8 block, ≥0.5 warn, <0.5 pass
  actionOverrides:
    - action: read_issue
      requiresApproval: false
      allowedResources:
        - "owner/repo1"
        - "owner/repo2"
```

Injected MCP servers are automatically proxied through the daemon. Auth headers are injected server-side, and responses pass through the same PII sanitization pipeline. Agents never see raw credentials or unsanitized data.

### Azure PIM Groups

For workspace pods that need elevated Azure access, configure PIM activations directly on the profile or pass group activations at pod creation:

```yaml
pimActivations:
  - type: group
    groupId: "00000000-0000-0000-0000-000000000000"
    displayName: "Contributor on prod-rg"
    duration: "PT1H"
    justification: "Autopod workspace pod"
```

```bash
ap workspace my-app --pim-group "00000000-0000-0000-0000-000000000000:Contributor on prod-rg"
```

PIM groups are activated automatically when the workspace starts and deactivated when it ends. Only groups pre-configured on the pod can be activated — agents cannot escalate beyond what was declared.

### Execution Targets

```yaml
executionTarget: local   # Run containers on the local Docker socket (default)
# or
executionTarget: sandbox # Run containers in Azure Container Apps Sandboxes
```

| | Local | Sandbox (Azure Container Apps) |
|--|--|--|
| Setup | Docker socket | Azure subscription + preview enrollment + ACR warm image |
| Cost | Host resources | Scale-to-zero (pay nothing when idle) |
| Isolation | Docker bridge per pod | Per-sandbox microVM |
| Egress control | iptables + HAProxy | Native per-sandbox egress policy (all modes) |
| Scale | Host CPU/memory | Azure quota |
| Cold start | Fast (cached image) | Warm-image disk creation + sandbox start |

> **Status:** the `sandbox` target is wired behind Azure Container Apps Sandboxes. It requires
> an ACR-published `profile.warmImageTag`, SandboxGroup data-plane RBAC, an ACR pull identity,
> and a daemon MCP host reachable from Azure. See `docs/azure-container-apps-sandboxes.md` for
> the exact env vars, RBAC model, and smoke command.

### Profile Versioning

Every `ap profile edit` or API update auto-increments `profile.version`. When a pod is created, autopod snapshots the full resolved profile (including inherited values) and stores it with the pod. You can always audit exactly which config produced a given pod's output — even after the profile has changed.

```bash
ap profile show my-app    # Shows current version number
ap status <pod-id>        # Shows "profile: my-app v3 · branch: autopod/abc123ef"
```

### Memory Stores

Autopod records memory candidates from reviewer-model extraction after pod activity, then asks humans to approve before any candidate is reused. Approved memories carry scope (`global`, `profile`, or `pod`), source evidence, usage history, and stale/harmful evidence so operators can see whether a memory is helping future pods.

```yaml
# Memory is scoped — available only to matching pods
# global  → all pods on this daemon
# profile → all pods using this profile
# pod     → this pod only (auto-scoped by the agent)
```

The daemon selects and injects matching approved memories into each pod's CLAUDE.md at provisioning time. Agents also report memory usage through MCP so the dashboard can track which memories were selected, injected, and later judged helpful or stale.

```http
GET    /memory
GET    /memory/candidates?status=pending
PATCH  /memory/candidates/:id
GET    /memory/:id/usage
GET    /memory/:id/source-evidence
GET    /memory/:id/stale-evidence
DELETE /memory/:id
```

### Issue Watcher

Enable the issue watcher on a profile to automatically spawn pods from labeled GitHub or ADO issues.

```yaml
issueWatcherEnabled: true
issueWatcherLabelPrefix: "autopod"   # default
```

**Label routing:**

| Label | Behavior |
|-------|----------|
| `autopod` | Spawn a pod using this profile |
| `autopod:backend` | Route to the profile named `backend` (must share same repo) |
| `autopod:artifact` | Force `outputMode: artifact` — produce a research artifact, not a PR |

**Lifecycle:**

1. Daemon polls issues every 60s for the trigger label
2. Issue title + body + ACs are sanitized (PII stripped, prompt injection checked)
3. Pod is spawned; trigger label swapped for `autopod:in-progress`
4. Agent escalations post as comments on the issue
5. On completion: label updated to `autopod:done` or `autopod:failed`, final comment posted

---

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
4. Enable **"Allow public client flows"** (for device code flow on headless machines)
5. Under **Expose an API**, set the Application ID URI to `api://<application-client-id>`
6. Add a delegated scope named `access_as_user`
7. Note the **Application (client) ID** and **Directory (tenant) ID**
8. Add them to your daemon `.env`:

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
ap auth login
```

For the hosted desktop daemon flow, see `docs/hosted-daemon-tls-entra.md`.

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

CI/CD runs via GitHub Actions — see `.github/workflows/deploy.yml`.

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

For production, yes — autopod is built around Azure Container Apps, ACR, and Key Vault. For local development, Docker Compose is all you need.
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

Always. Nothing merges without an explicit `ap approve`. The `validated` state means "autopod thinks it's good" — but you always have the final say.
</details>

<details>
<summary><b>Can I use this for non-web projects?</b></summary>

Yes. Set `hasWebUi: false` on the profile and lean on `lintCommand`, `sastCommand`, `buildCommand`, `testCommand`, command/API acceptance criteria, required facts, and AI task review. Browser smoke and web-ui AC checks are skipped when there is no frontend.
</details>

<details>
<summary><b>Can I use Azure DevOps instead of GitHub for PRs?</b></summary>

Yes. Set `prProvider: ado` on your profile and provide an ADO personal access token. autopod supports both `dev.azure.com` and `visualstudio.com` URL formats.
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

## License

MIT

---

<p align="center">
  <sub>Built with mass amounts of mass-produced LLM tokens and mass-produced caffeine.</sub>
</p>
