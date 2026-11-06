# CLI reference

[README](../../README.md) · [Getting started](../getting-started.md) · [CLI](cli.md) · [Profiles](profiles.md) · [Validation](validation.md) · [Operations](operations.md)

## CLI Reference

### Authentication

```bash
ap login                     # Reuse/refresh the session; browser SSO only when required
ap login --browser           # Force the legacy local browser callback
ap login --device            # Device code flow (headless/SSH)
ap logout                    # Clear credentials
ap whoami                    # Current user + daemon status
```

`ap login` first renews an existing MSAL session without opening a browser. If
interaction is required from an agent or other non-TTY process, the CLI opens
the same browser SSO page but receives its one-time PKCE callback through the
configured HTTPS daemon instead of waiting on a sandbox-inaccessible loopback
port. Successful login persists MSAL refresh state with owner-only permissions;
when the home directory is read-only, it uses an owner-only per-user runtime
cache. `ap logout` clears both copies. Entra policy or account revocation can
still require a new interactive or device login.

### Daemon

```bash
ap connect <url>             # Connect CLI to a daemon
ap disconnect                # Disconnect
ap health                   # Show daemon release and backup readiness
ap stop                     # Gracefully stop the daemon
```

### Profiles

```bash
ap profile create           # Create a profile in $EDITOR
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

Source selection in the updated CLI uses **published remote branch names**:
`--start-branch feature/prep` selects the starting source, `--base-branch main`
selects the base (and fallback starting source), and `--branch fix/result` names
the output branch. Full commit SHAs and Git revision expressions are refused for
start/base selectors on new requests, including configuration previews and JSON
configuration files. This change takes effect when the updated CLI is released.

Keep a researched baseline SHA in task evidence separately from the launch branch.
Record the actual supplied checkout SHA and any mismatch with that baseline.
A preview resolves configuration; it does not prove remote branch availability
or pin a moving branch. Exact-revision requirements need a separately supported
control-plane path. `--reference repository=SHA` retains its independent snapshot
semantics. Exact saved-request retries preserve their identity and digest and go
straight to daemon admission without new source checks or mutable discovery;
previewing such a receipt does run source checks and does not rewrite it.

```bash
ap run --repo Project --task "Implement the fix" \
  --start-branch feature/prep --base-branch main --branch fix/result
```

```bash
# Create
ap run <profile> "<task>"                   # Start a pod
ap run <profile> "<task>" --model claude-opus-4-8  # Override model
ap run <profile> "<task>" --runtime codex   # Use Codex runtime
ap run <profile> "<task>" --runtime copilot # Use Copilot runtime
ap run <profile> "<task>" --branch feat/x   # Custom branch name
ap run <profile> "<task>" --skip-validation # Skip auto-validation
ap run --repo Project --task "Implement" --base-branch feat/plan  # Published source/base branch
ap run <profile> "<task>" --ac-from specs/ac.md    # Load acceptance criteria from a file in the repo
ap run <profile> "<task>" --sidecar dagger          # Request a configured sidecar
ap run <profile> "<task>" --ref-repo https://github.com/org/repo.git
ap run <profile> "<task>" --ref-from-profile docs-repo

# Monitor
ap ls                                       # List pods
ap ls --status running                      # Filter by status
ap ls --status failed,review_required,complete,killed --since 7d # Recent terminal pods
ap ls --since 2026-01-01T00:00:00Z          # Pods created since an ISO timestamp
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
ap diff <id>                                # Show the current pod diff
ap diff <id> --json                         # Diff files, statuses, patches, and stats
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

`ap diff` reads the daemon’s current diff endpoint. If that request fails, it falls
back to the stored task-review diff when available. `--json` prints the full endpoint
response; a fallback contains `files`, `stats`, and `source: "task-review"`. If neither
source is available, the command fails instead of reporting an empty diff.

### Spec Utilities

```bash
ap spec check specs/my-feature              # Validate a spec folder locally
ap spec check specs/my-feature --json       # Versioned, credential-free diagnostics
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
  - "01-schema"
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

Run `ap spec check <folder> --json` before dispatch and repair every diagnostic
until it returns `"valid": true`. The stable response has
`diagnosticsVersion: 1`, `contractVersion: 1`, `valid`, and a `diagnostics`
array; each diagnostic includes a stable code, source file, field path,
message, and repair hint (plus line/column for YAML document errors when
available). This command is local: it does not load profiles, credentials, or
the daemon. `ap series create` runs the same preflight before creating a client.

Contract v1 accepts an empty `scenarios` list and an empty `required_facts`
list. `depends_on` and `human_review` are optional. Titles are limited to 200
characters; dependency, scenario, fact, review IDs and scenario references to
128; artifact paths to 500; commands to 1000; review criterion/reason to 500.
Scenario IDs, required-fact IDs, and human-review IDs must each be unique.
Every Given/When/Then list, fact `proves` list, and review `covers` list must be
non-empty. References must name declared scenario IDs, and every scenario must
be covered by a fact or human review. Fact kinds are `unit-test`,
`integration-test`, `contract-test`, `browser-test`, `typecheck`, `lint-rule`,
`smoke-script`, and `custom-command`; artifact changes are `create`, `update`,
and `touch`.

Required-fact commands must be executable and scenario-specific: generic
package-manager `test`, `build`, or `lint` commands and
`validate_in_browser` MCP syntax are rejected. Reusing the same broad command
across facts is rejected unless it is narrowed with `--grep`, `-g`, or
`--testNamePattern`. `artifact.change: touch` imposes no diff requirement, but
the artifact must still exist and the fact command must succeed. A copyable
valid scaffold lives at `templates/series-contract-v1/`.

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
