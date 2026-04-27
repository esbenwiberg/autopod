# ADR 003: Container MCP calls proxy through the runner

## Context

Containers today dial `http://${AUTOPOD_CONTAINER_HOST}:${PORT}/api/mcp/:sessionId`
for escalation + actions. With a remote runner, the container is on the
runner's Docker network — it must reach the daemon somehow.

Two options:
1. **Container dials daemon directly.** `AUTOPOD_CONTAINER_HOST` is set per
   session to the daemon's Tailscale / public URL. Container needs egress
   to that specific URL.
2. **Container dials the runner's loopback.** Runner proxies the HTTP call
   over its persistent WS to the daemon. `AUTOPOD_CONTAINER_HOST` points at
   `host.docker.internal:<runner-mcp-port>`.

## Decision

**Container dials the runner's loopback.** Runner proxies over WS.

## Consequences

**Good**
- Containers never need daemon network reachability. Simplifies network
  policy (restricted firewall doesn't need daemon in allowlist).
- Same MCP URL pattern works for Pi daemon, Azure daemon, moving daemons —
  runner figures it out.
- Existing session-scoped Bearer token auth unchanged; runner is
  transparent to the auth flow.
- Runner can't impersonate a session — the Bearer token is validated by
  the daemon.

**Bad**
- One extra hop per MCP call. Latency budget: < 50ms added (loopback hop
  is negligible; WS is persistent so no connect overhead).
- Runner must implement a small HTTP server + WS-based request/response
  correlation. Non-trivial but bounded.
- Runner crash breaks in-flight MCP calls even if the container is still
  alive. Session will likely derail; acceptable (same outcome as network
  partition).

## Alternatives

- **Direct daemon URL.** Rejected — couples container network policy to
  daemon location, and breaks cleanly when daemon moves (Pi → Azure VM).
- **Pre-shared MCP gateway on each runner with its own auth.** Adds a
  separate credential/token system per runner; needless complexity.
