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
