# 002 — Tool-neutral CLI; autopod is a consumer

## Claim
The atom system is its own standalone repo, with a CLI + MCP server. Autopod consumes it the same way Cursor, plain Claude Code, or Copilot would.

## Context
If we build this as an autopod-internal feature, the value is concentrated in one tool. Extracting it lets any repo (and any AI tool) use it, which is the actual goal — Esben's colleagues working without autopod should get equal value.

## Decision
- Standalone repo. Name deferred — see `../open-questions.md`.
- CLI commands: `init`, `lint`, `stale`, `coverage`, `select`, `walk`, `distill`.
- MCP server exposes `context.select(envelope)`, `context.walk(file)`, `context.search(query)` for direct agent consumption.
- Autopod becomes a consumer: spawns the CLI/MCP, layers approval workflow + telemetry on top.

## Constraint
**Do not extract the standalone tool until at least one consuming repo demonstrates value in the pilot.** The premortem flagged "non-autopod adoption fails" as a real risk — extracting too early ships an autopod-shaped CLI that nobody else wants. Build inside the pilot first, extract when shape stabilizes.

## Rejected alternatives
- **Autopod-internal feature only** — loses tool-neutrality, the whole point of this design.
- **Library-only, no CLI** — humans need to lint/inspect/search without spawning an agent.
- **Multi-repo monorepo from day 1** — premature; not yet clear what the package boundary should be.

## Provenance
Chat with Esben, 2026-05-28; sharpened by premortem failure mode 3.9 (non-autopod adoption fails).
