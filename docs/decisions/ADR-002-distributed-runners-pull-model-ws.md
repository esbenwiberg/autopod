# ADR 002: Runner dials out — outbound WebSocket

## Context

Connection topology between daemon and runner needs to handle:
- Laptop behind NAT / home network (no inbound holes).
- Pi daemon behind home NAT (same problem, inverse direction).
- Azure daemon reachable on a public URL.
- Tailscale-style mesh networks where either side might be reachable.

## Decision

Runner **dials out** to the daemon over a persistent WebSocket (HTTPS).
Daemon never initiates a TCP connection to the runner.

Protocol framing:
- JSON text frames for control messages, each with a correlation `id`.
- Binary frames for workspace tar payloads, scoped by the most recent
  `workspace_*_start` message id.

Heartbeats at an interval specified in the daemon's `welcome` message
(default 10s). Runner reconnects with exponential backoff (capped at 30s)
on WS close.

## Consequences

**Good**
- No inbound firewall configuration on the laptop. Ever.
- Works identically in every deployment scenario — Tailscale, public
  daemon, mixed.
- Reconnection semantics are well-understood (WS libraries handle this).
- Matches how runner systems like GitHub Actions, Buildkite, Depot work.

**Bad**
- Long-lived connections consume a Node event-loop slot on the daemon
  per runner. Fine at single-user scale.
- Reverse operations (daemon → runner) require correlation IDs and a
  waiter table. Adds some complexity vs a RESTful push API.
- Streaming exec calls (`execStreaming`) need multi-message chunk/end
  semantics — not just request/response. Requires careful protocol
  handling.

## Alternatives

- **Daemon pushes over HTTPS** (REST to the runner). Rejected — requires
  inbound reachability on the runner.
- **gRPC bidi stream.** Solves the same problem as WebSocket but adds a
  dependency; WS is already used in the codebase (`packages/daemon/src/api/websocket.ts`).
  Revisit if we need strict typing / codegen.
- **SSE from daemon + HTTPS POSTs from runner.** Works but splits the
  logical stream across two transports and complicates ordering; not worth
  the complexity over a single WS.
