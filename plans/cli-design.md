---
title: "CLI Design"
status: exploring
published: true
date: 2026-03-14
---

## Overview

The CLI is called `ap`. Two letters, fast to type. Installed globally via npm or as a standalone binary.

```bash
npm install -g @esbenwiberg/autopod
# provides both `autopod` and `ap` commands
```

## Commands

### Authentication

```bash
# Login via Entra ID (auto-detects best flow)
ap login                    # PKCE if local terminal, device code otherwise
ap login --device           # force device code flow (SSH, headless)
ap logout                   # clear stored credentials
ap whoami                   # show current user and daemon connection
```

Tokens stored in `~/.autopod/credentials.json`. Refresh tokens auto-renew silently for ~90 days.

### Daemon

```bash
# Connect to a running daemon
ap connect <daemon-url>     # e.g., ap connect https://autopod.mycompany.com
ap disconnect

# Local mode (for development/testing)
ap daemon start --local     # runs daemon locally with Docker
ap daemon stop
ap daemon status
```

### Profiles

```bash
# Create a profile
ap profile create <name> \
  --repo <owner/repo> \
  --template <stack-template> \
  --build "<build command>" \
  --start "<start command>" \
  --health "<path>" \
  --model <default-model> \
  --instructions "Custom instructions for the agent"

# Manage profiles
ap profile ls                           # list all profiles
ap profile show <name>                  # show profile details
ap profile edit <name>                  # open in $EDITOR
ap profile delete <name>
ap profile warm <name>                  # pre-bake deps into Docker image
ap profile warm <name> --rebuild        # force rebuild

# Inheritance
ap profile create my-site \
  --extends astro-base \
  --repo esbenwiberg/my-site
```

### Sessions

```bash
# Start a session
ap run <profile> "<task description>"
ap run <profile> "<task>" --model opus          # override model
ap run <profile> "<task>" --model codex --runtime codex  # use Codex
ap run <profile> "<task>" --branch fix/auth     # custom branch name
ap run <profile> "<task>" --no-validate         # skip auto-validation

# Monitor
ap ls                                   # list all sessions
ap status <id>                          # detailed session info
ap logs <id>                            # stream agent activity
ap logs <id> --build                    # show build/validation logs

# Interact with running sessions
ap tell <id> "<message>"                # send instruction
ap tell <id> --file feedback.md         # send from file
ap tell <id> --stdin                    # pipe from stdin

# Validation
ap validate <id>                        # trigger validation manually
ap validate <id> --page /about          # validate specific page

# Preview
ap open <id>                            # spin up on-demand preview (~30-60s)
                                        # → opens https://<id>.autopod.dev
                                        # → auto-kills after 30min idle
ap screenshots <id>                     # show screenshot URLs from blob storage

# Review and complete
ap diff <id>                            # show git diff (staged for merge)
ap diff <id> --stat                     # summary only
ap approve <id>                         # create PR with screenshots, merge
ap approve <id> --squash                # squash merge
ap reject <id> "<feedback>"             # send feedback, agent retries
ap reject <id> --file feedback.md       # detailed feedback from file
ap kill <id>                            # destroy pod, discard work

# Bulk operations
ap approve --all-validated              # approve all validated sessions
ap kill --all-failed                    # kill all failed sessions
```

### Dashboard

```bash
# TUI dashboard (real-time)
ap watch
```

The dashboard shows:

```
╔══════════════════════════════════════════════════════════════╗
║  autopod                                          4 sessions ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  ID    Profile      Task                 Model   Status      ║
║  ───── ──────────── ──────────────────── ─────── ─────────── ║
║ >a1b   ideaspace    Add dark mode toggle opus    validated    ║
║  c3d   ideaspace    Fix auth redirect    codex   running 4m  ║
║  e5f   my-api       Add pagination       sonnet  errored     ║
║  g7h   my-api       Fix rate limiting    opus    running 1m  ║
║                                                              ║
║  ─── a1b ──── validated ─────────────────────────────────── ║
║  Screenshots: 3 pages captured                               ║
║  Duration: 12m | Files changed: 4 | Lines: +87 -12          ║
║  Verdict: pass — "Toggle visible in navbar, persists state"  ║
║                                                              ║
║  ─── c3d ──── running ──────────────────────────────────── ║
║  > Reading src/auth/middleware.ts                             ║
║  > Editing src/auth/redirect.ts (+12 -3)                     ║
║  > Running: npm test                                         ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  [enter] select  [t]ell  [d]iff  [a]pprove  [r]eject        ║
║  [o]pen  [l]ogs  [k]ill  [v]alidate  [s]creenshots  [q]uit  ║
╚══════════════════════════════════════════════════════════════╝
```

Navigate with arrow keys. Actions apply to the selected session. `t` opens an inline text input for sending messages. `s` opens screenshot URLs in the browser.

## Output Formats

All commands support structured output for scripting:

```bash
ap ls --json                            # JSON output
ap ls --json | jq '.[] | select(.status == "validated")'

ap run ideaspace "add auth" --json      # returns session ID as JSON
session_id=$(ap run ideaspace "add auth" --json | jq -r '.id')
ap tell "$session_id" "use JWT tokens"
```

## Configuration

Global config lives in `~/.autopod/config.yaml`:

```yaml
daemon: https://autopod.mycompany.com
default_model: opus

notifications:
  teams:
    webhook: https://prod-xx.westeurope.logic.azure.com/workflows/...
    events: [validated, failed, needs_review, escalation]
  desktop: true
  sound: false

watch:
  theme: dark                   # TUI theme
  refresh_interval: 1000        # ms
```

## Aliases and Shortcuts

Common workflows as shortcuts:

```bash
# Quick run with defaults (uses profile's default model)
ap run ideaspace "fix the header"

# Equivalent to:
ap run ideaspace "fix the header" \
  --model opus \
  --runtime claude \
  --branch feature/fix-the-header-a1b2c3
```

## Exit Codes

For scripting and CI integration:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Auth failure |
| 3 | Session not found |
| 4 | Validation failed |
| 5 | Daemon unreachable |
