# Profile configuration

[README](../../README.md) · [Getting started](../getting-started.md) · [CLI](cli.md) · [Profiles](profiles.md) · [Validation](validation.md) · [Operations](operations.md)

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
template: node24-pw
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
# Git and REST auth use the daemon host's Azure CLI / managed identity.
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

For runnable specs created by your planning workflow, put executable proof in `contract.yaml` (`scenarios`, `required_facts`, and optional `human_review`) rather than brief frontmatter ACs. Required facts run during validation and produce attempt-scoped evidence YAML.

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

Choose egress controls for the workload and inspect the effective launch policy.
Docker and Azure Sandboxes enforce it differently; see the
[security boundaries guide](../security-overview.md#worker-egress).

```yaml
networkPolicy:
  enabled: true

  # Mode controls the firewall behaviour:
  #   restricted  — resolved hostname allowlist (HTTPS SNI proxy on Docker)
  #   deny-all    — exception-only egress; not an air gap
  #   allow-all   — no outbound restrictions (useful for debug)
  mode: restricted

  # Hosts to allow. Wildcards match on SNI suffix.
  allowedHosts:
    - "api.stripe.com"
    - "*.my-company.com"

  # Remove the built-in provider/registry host set.
  # This does not remove control-plane exceptions or other derived hosts.
  replaceDefaults: false

  # Shorthand: automatically add all common package manager hosts.
  # Covers npm, yarn, pypi, crates.io, nuget, golang, rubygems, debian apt, etc.
  allowPackageManagers: true
```

**How `restricted` mode works — HAProxy SNI proxy:**

On Docker, `restricted` mode redirects outbound port 443 through an HAProxy
instance inside the container. It checks the TLS ClientHello SNI against the
resolved allowlist and splices the original TLS bytes—no MITM or certificate
substitution. Port 80 is dropped, not proxied. DNS is allowed through Docker's
embedded resolver; daemon gateway and declared sidecar paths are explicit
exceptions. Denials are recorded as safety evidence. Sandboxes uses its native
egress policy instead of this Docker implementation.

This means egress policy is enforced at the hostname level even for HTTPS, without breaking TLS.

**Restricted-mode built-in hosts** (included unless `replaceDefaults: true`):

`api.anthropic.com`, `api.openai.com`, `registry.npmjs.org`, `pypi.org`, NuGet hosts, Azure CDN hosts, `pkgs.dev.azure.com`, `platform.claude.com`, and GitHub Copilot endpoints. `github.com` / `raw.githubusercontent.com` are intentionally not on the default list; add them explicitly only for profiles that need direct GitHub egress (for example, GitHub-hosted package dependencies).

**Updates:** use supported configuration/update paths and inspect the effective
policy on running pods. Editing a profile alone is not proof that an existing
worker's firewall changed; frozen launch authority and retained-source guards
also matter.

**Derived hosts:** restricted allowlist resolution can include configured MCP
and registry hosts in addition to explicit entries. `deny-all` does not thereby
open general access to every remote MCP host; brokered MCP uses the daemon path.

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

Remote injected MCP servers can be proxied through the daemon with auth headers
added server-side. However, the normal server registration does not wire the
proxy's optional content-processing hook: don't assume its responses have
Autopod's injection/PII filtering. Action-response filtering is a separate path,
and workers can still receive selected runtime/tool credentials. See the
[security boundary details](../security-overview.md#prompt-injection-and-data-hygiene).

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
> and a daemon MCP host reachable from Azure. See [the sandbox guide](../azure-container-apps-sandboxes.md) for
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
