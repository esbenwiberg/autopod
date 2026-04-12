# Brief 08: Runner — MCP proxy

## Objective

Host a local HTTP server on the runner that containers dial for MCP
callbacks; forward each HTTP request to the daemon over the persistent WS
and return the daemon's response to the container.

## Dependencies

Briefs 01, 06.

## Blocked By

Brief 06.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/runner/src/mcp/proxy-server.ts` | create | Starts a Fastify (or plain Node http) server on `RUNNER_MCP_PORT`, handles all HTTP methods + paths under `/mcp/*` |
| `packages/runner/src/mcp/proxy-server.test.ts` | create | Tests request/response round-trip |
| `packages/runner/src/mcp/pending-responses.ts` | create | Correlation map for in-flight MCP requests |
| `packages/runner/src/commands/start.ts` | modify | Launch proxy on startup, shut down on WS close / cleanup (shared file — Brief 06 owns but explicit hook points) |

## Interface Contracts

None new (reuses `mcp_request` / `mcp_response` from Brief 01).

## Implementation Notes

- Minimal proxy — don't parse or validate MCP protocol. Forward bytes.
- On incoming HTTP request:
  1. Generate a correlation `id`.
  2. Collect body into a string (MCP bodies are small JSON).
  3. Build an `mcp_request` message with `method`, `path`, `headers`, `body`.
  4. Store resolver in `pending-responses` keyed by `id`.
  5. Send over WS.
  6. Await `mcp_response` with matching `id`, reply to HTTP client with
     that status/headers/body.
- Timeout: 60s per MCP request. On timeout, return 504 to the container
  and clean up the pending map.
- WS close during in-flight call: reject all pending MCP requests with 503
  so containers see a clean error instead of hanging.
- Expose the proxy on `127.0.0.1:${RUNNER_MCP_PORT}`. Ports:
  - Default `7789` (`RUNNER_DEFAULT_MCP_PORT` from shared).
  - Override via config (`config.mcpPort`) and env (`RUNNER_MCP_PORT`).
- Container-side env: `AUTOPOD_CONTAINER_HOST=host.docker.internal:${RUNNER_MCP_PORT}`
  is injected by the runner's Docker adapter (Brief 07) when spawning.
  Coordinate: Brief 07 imports `MCP_PORT` from the MCP proxy module at
  spawn time.
- Daemon-side: when building the container env, the daemon injects
  `AUTOPOD_CONTAINER_HOST=host.docker.internal:${runner.mcpPort}`. The
  runner advertises `mcpPort` in the `hello` message per contracts.md —
  it's already part of Brief 01's scope.

## Acceptance Criteria

- [ ] Proxy server starts on the configured port, binds loopback only.
- [ ] HTTP request to `/mcp/test` is forwarded to the daemon as an
  `mcp_request` with method/path/headers/body intact.
- [ ] Daemon's `mcp_response` returns to the container with correct status
  + headers + body.
- [ ] 60s timeout produces 504 to the container.
- [ ] WS close rejects pending requests with 503.
- [ ] Large MCP responses (up to 1 MB) are not truncated.
- [ ] Proxy does not accept non-loopback connections.

## Estimated Scope

Files: 3 created + 1 modified | Complexity: medium
