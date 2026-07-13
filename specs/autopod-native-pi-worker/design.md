# Design — Autopod-native Pi worker

## Blast radius

- `packages/pi-worker/` — new trusted Pi extension and MCP clients.
- `packages/shared/src/types/` and `packages/shared/src/schemas/` — Pi runtime and provider credential contracts.
- `packages/daemon/src/runtimes/` — RPC controller, parser, runtime, and registration.
- `packages/daemon/src/providers/` — Pi auth file construction and refresh persistence.
- `packages/daemon/src/images/` — pinned Pi/worker installation.
- `packages/cli/src/commands/` — runtime selection and isolated Pi OAuth capture.
- `packages/desktop/Sources/AutopodClient/`, `AutopodUI/`, and `AutopodDesktop/` — API models, profile UI, and authentication.

## Seams

1. **Pi extension ↔ MCP servers:** Brief 01 owns MCP discovery/call adaptation and exports the pinned extension entrypoint consumed by the runtime.
2. **Pi process ↔ Autopod runtime:** Brief 02 owns strict JSONL RPC and normalized `AgentEvent` output.
3. **Credential owner ↔ Pi auth storage:** Brief 02 owns the provider-entry contract, container file, and refresh read-back; Briefs 03 and 04 own CLI/desktop capture clients.
4. **Runtime/profile contract ↔ product surfaces:** Brief 03 owns TypeScript schema, daemon registration, images, and CLI; Brief 04 consumes those values in Swift.

## Contracts

```ts
export type RuntimeType = 'claude' | 'codex' | 'copilot' | 'pi';

export interface Runtime {
  type: RuntimeType;
  spawn(config: SpawnConfig): AsyncIterable<AgentEvent>;
  resume(podId: string, message: string, containerId: string, env?: Record<string, string>): AsyncIterable<AgentEvent>;
  abort(podId: string): Promise<void>;
  suspend(podId: string): Promise<void>;
}
```

Pi RPC uses LF-only JSON records. Every outbound command carries a correlation ID. A successful `prompt` response means accepted, not completed; completion is derived from terminal agent events plus process outcome.

The worker package consumes `SpawnConfig.mcpServers` without changing its HTTP/stdio union. It must preserve server headers, parameter schema semantics, text/error results, cancellation, and long-running calls. Required Autopod MCP initialization failure is terminal.

A Pi OAuth credential owner stores exactly one pair:

```ts
interface PiOAuthCredential {
  providerId: 'anthropic' | 'openai-codex' | 'github-copilot';
  credential: Record<string, unknown>; // validated opaque Pi OAuth entry
}
```

Container injection reconstructs `{ [providerId]: credential }` at `/home/autopod/.pi/agent/auth.json`. Read-back may update only the same provider and owner. Existing Claude/Codex/Copilot credential fields remain valid.

Managed invocation pins provider/model explicitly and disables automatically discovered executable project extensions. The trusted worker extension is loaded explicitly.

## UX flows

### CLI

`ap profile auth-pi <profile> <provider>` opens Pi login in an isolated temporary agent directory, waits for completion, validates and extracts only the selected entry, patches the profile/provider account, and deletes temporary files. Cancellation, missing Pi, malformed auth, or wrong provider returns an actionable error without modifying stored credentials.

Runtime selection continues through existing profile and pod commands; `pi` is additive and defaults remain unchanged.

### Desktop

The existing Agent section gains Pi in the runtime picker; this is not a new or rearranged screen. Selecting Pi updates compatible model choices. The Providers section offers Pi authentication for supported subscription providers using the existing Terminal.app authentication pattern. Progress, success, cancellation, missing CLI, and malformed credential states use existing auth-status UI.

## Reference reading

- `AGENTS.md` — architecture, testing, migration, and profile-field rules.
- `packages/shared/src/types/runtime.ts` — runtime and event contract.
- `packages/daemon/src/runtimes/claude-runtime.ts` — streaming process, MCP retention, resume, abort, and suspend precedent.
- `packages/daemon/src/runtimes/codex-runtime.ts` — false-completion defenses and credential/session precedent.
- `packages/daemon/src/api/mcp-handler.ts` — pod-token Streamable HTTP behavior and long blocking requests.
- `packages/escalation-mcp/src/server.ts` — fixed and dynamic tool surface.
- `packages/daemon/src/providers/env-builder.ts` — secret-file injection and provider branching.
- `packages/daemon/src/providers/credential-persistence.ts` — owner-aware refresh persistence.
- `packages/desktop/Sources/AutopodDesktop/Services/ProfileAuthenticator.swift` — isolated Terminal login capture.
- `docs/azure-container-apps-sandboxes.md` — streaming exec and warm-image constraints.
- Pi `docs/rpc.md`, `docs/extensions.md`, and `docs/providers.md` — RPC framing, extension tools, and OAuth storage.

## Decisions

- ADR-033: Add Pi as an Autopod-native worker beside vendor runtimes.
- ADR-031: Azure Container Apps Sandboxes backend.
- ADR-028: Canonical model ID input policy.
