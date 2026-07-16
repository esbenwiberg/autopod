---
title: "Build the trusted Pi MCP worker bridge"
touches:
  - packages/pi-worker/
  - package.json
  - pnpm-lock.yaml
does_not_touch:
  - packages/escalation-mcp/src/server.ts
  - packages/daemon/src/actions/
  - packages/daemon/src/api/mcp-handler.ts
require_sidecars: []
---

## Task

Create the pinned Autopod Pi worker package that exposes every configured HTTP or stdio MCP tool as a native Pi tool. Preserve MCP schemas, headers, arguments, results, cancellation, and long-running requests. Treat the Autopod control-plane server as mandatory, reject tool-name collisions, and fail closed when mandatory discovery or initialization fails. Ensure managed-worker startup does not allow repository-provided executable Pi resources to replace mandatory tools.

## Research summary

Pi has no built-in MCP client, but extensions can dynamically register tools. Autopod already passes a transport-neutral `SpawnConfig.mcpServers` list and hosts the authenticated Streamable HTTP control plane at `/mcp/:podId`. Read `research.md` and `plan.md` before coding.

## Plan

Implement a small Pi package with separate HTTP/stdio client adapters and one extension entrypoint. Keep it transport-only: policy and privileged behavior remain behind MCP. Export a deterministic startup/configuration contract for `PiRuntime` to consume in the next brief.

## Checkpoints

1. Establish package and typed worker configuration.
2. Implement both MCP transports and dynamic tool registration.
3. Add fail-closed required-server, collision, cancellation, and result tests.
4. Document the runtime-facing invocation/configuration contract in package exports.

## Touches

- `packages/pi-worker/`
- `package.json`
- `pnpm-lock.yaml`

## Does not touch

- `packages/escalation-mcp/src/server.ts`
- `packages/daemon/src/actions/`
- `packages/daemon/src/api/mcp-handler.ts`

## Constraints

Honor the MCP and managed-worker contracts in `design.md`. Do not duplicate `PodBridge`, action approval, validation, memory, sanitization, or audit logic. Bound tool output and sanitize transport errors without hiding actionable control-plane failures. Use abort signals throughout.

## Test expectations

Create co-located tests using fake HTTP and stdio MCP servers. Prove distinct servers/tools produce distinct registered tools and forwarded arguments/results; headers are forwarded; long calls are not given a short default timeout; cancellation reaches the MCP request; duplicate names fail; and a missing mandatory Autopod server fails startup rather than producing a reduced worker.

## Risks / pitfalls

Pi tool registration and MCP schema representations differ. Do not silently weaken unsupported schemas. Streamable HTTP requests can remain open for the full human-response timeout. Repository project trust must not become an extension override path.

## Wrap-up

Before finishing:
1. Run the profile finish prompt if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
