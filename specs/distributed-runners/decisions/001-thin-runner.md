# ADR 001: Thin runner, daemon stays authoritative

## Context

The feature requires sessions to run on a remote host (laptop). Two shapes
are viable:

- **Thick runner** — runner owns its own bare repo cache, worktree manager,
  git push, diff read, and local Docker.
- **Thin runner** — runner is a secure remote `ContainerManager` + MCP
  proxy + workspace tar I/O. Daemon keeps worktree + git + PR logic.

Forces:
- Repos in this user's scope are **< 500 MB** — workspace tar over Tailscale
  is bounded (~30s RTT typical).
- User does **not** need laptop-local worktree inspection.
- `ContainerManager` is already transport-agnostic; thin mapping is
  straightforward.
- Thick runner duplicates `LocalWorktreeManager` + parts of PR flow into
  a second package; maintenance cost is forever.

## Decision

**Thin runner.** Daemon stays the single source of truth for worktrees, git
ops, and PRs. Runner executes containers and proxies MCP.

## Consequences

**Good**
- Minimal code duplication — one worktree manager, one PR flow.
- Mirrors how `AciContainerManager` already works (thin executor).
- Runner package stays small and easy to install on new hosts.
- Daemon-only deploy changes (Pi / Azure VM) don't require runner changes.

**Bad**
- Per-session workspace tar transfer is a real cost (~30s for typical repos;
  minutes for larger). Acceptable given the repo size ceiling.
- If repos grow > 1 GB this decision becomes expensive; revisit then.
- Daemon must remain reachable during workspace upload/download, so a
  network blip during transfer can fail the session.

## Alternatives

- **Thick runner** — better for multi-GB repos and laptop-local worktree
  access; rejected because this user's repos are small and they don't need
  worktree inspection.
- **Medium runner (split git ownership)** — runner owns filesystem ops,
  daemon owns push via RPC; rejected as half-committed — inherits the
  duplication cost of thick with the coordination complexity of thin.
