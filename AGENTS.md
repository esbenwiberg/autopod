# Autopod agent instructions

Read [CLAUDE.md](CLAUDE.md), the canonical repository development and agent guide,
including [agent execution safeguards](CLAUDE.md#agent-execution-safeguards), before
working in this repository. Follow the applicable area instructions as well:

- [Shared](packages/shared/AGENTS.md)
- [CLI](packages/cli/AGENTS.md)
- [Validator](packages/validator/AGENTS.md)
- [Escalation MCP](packages/escalation-mcp/AGENTS.md)
- [Daemon](packages/daemon/CLAUDE.md)
- [End-to-end tests](e2e/AGENTS.md)

The shared `add-pod-state`, `add-profile-field`, and `deploy-hosted-daemon` skills
live in `.agents/skills/`. Their `.claude/skills/` entries are relative symlinks;
edit the canonical files in `.agents/skills/` rather than creating parallel copies.

High-level planning, investigation, triage, and pod-operations workflows are
user-global skills, not repository-bundled skills. Global skills are not daemon
builtins or automatically available in worker containers. Existing tool packs
referencing removed builtin names need explicit reconfiguration; repository
changes do not rewrite frozen launches.
