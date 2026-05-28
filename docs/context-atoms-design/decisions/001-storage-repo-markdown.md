# 001 — Storage is repo-local markdown

## Claim
Atoms live as markdown files in the repo, not in a daemon-private database.

## Context
Autopod's existing memory layer stores entries in SQLite. That works for autopod users but locks out colleagues using plain Claude Code, Cursor, Copilot, or no AI tool at all. The whole motivation for this design is tool-neutral context that any reader can consume.

## Decision
- Atoms live in `docs/context/{rationale,constraint}/*.md`.
- YAML frontmatter for structure, markdown for the body.
- Committed to git, reviewed in PRs alongside code changes.
- Tool-neutral by construction — any agent that can read files reads atoms.

## Rejected alternatives
- **SQLite-backed memory** — autopod-only, fails the tool-neutrality requirement.
- **External KB (Notion / Confluence)** — drifts harder than git-tracked files, requires auth, MCP-only access for AI.
- **Comments in code** — granularity too fine, clutters the codebase, can't cross-reference.
- **Separate notes branch / orphan branch** — out-of-flow, easy to forget.

## Open follow-ups
- Whether to also cache atoms in SQLite for fast selector queries. Deferred until the selector exists and we know its read patterns.

## Provenance
Chat with Esben, 2026-05-28, when discussing how colleagues without autopod would benefit.
