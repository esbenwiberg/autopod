# ADR 002: Always Kill Old Container, Spawn Fresh

## Context

After daemon restart, an orphaned session's Docker container might still be
alive (it runs `sleep infinity` with `AutoRemove: false`). We could either:
1. Reuse the running container (exec into it)
2. Kill it and spawn a fresh one

## Decision

Always kill the old container and spawn fresh. The worktree is bind-mounted,
so all file state survives regardless.

## Consequences

**Good:**
- No need to handle stale container state (broken exec sessions, zombie
  processes, expired credentials in container env)
- Fresh container gets latest image, clean process tree, fresh credentials
- Skills, CLAUDE.md, registry config are all re-written cleanly
- Simpler code — no "is the container healthy?" checks

**Bad:**
- Slightly slower recovery (container pull + start vs just exec)
- Loses any container-only state (files outside /workspace, running processes)

**Acceptable because:**
- Container-only state (outside /workspace bind mount) is ephemeral by design
- Recovery after a reboot already takes seconds — container start adds ~2-3s
- The alternative (reuse) has a large surface area of failure modes
  (broken network config, stale env vars, zombie agent processes)
