# @autopod/escalation-mcp

`@autopod/escalation-mcp` is the MCP server injected into agent containers. It is
the bridge between an agent and the daemon control plane for escalation,
validation, memory, and action tools.

Tool handlers live under `src/tools/`. Keep tool contracts explicit and route
daemon-facing behavior through the `PodBridge` interface so tests can stay
isolated.

Useful checks:

```bash
npx pnpm --filter @autopod/escalation-mcp test
npx pnpm --filter @autopod/escalation-mcp typecheck
npx pnpm --filter @autopod/escalation-mcp build
```
