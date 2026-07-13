# Research — Autopod-native Pi worker

## Current runtime architecture

Autopod normalizes agent CLIs behind `Runtime` in `packages/shared/src/types/runtime.ts`. A runtime owns `spawn`, `resume`, `abort`, and `suspend`, and emits `AgentEvent`. `packages/daemon/src/index.ts` registers Claude, Codex, and Copilot; `pod-manager.ts` selects one by `pod.runtime` and passes the same container, environment, instructions, and merged MCP server list.

Claude and Codex establish the implementation precedent in `packages/daemon/src/runtimes/claude-runtime.ts` and `codex-runtime.ts`: write runtime-specific MCP configuration, start the CLI through `ContainerManager.execStreaming`, parse its JSON stream, retain session and MCP state for recovery, and use the shared stream liveness/post-completion helpers. The Azure Sandboxes implementation now supplies true streaming exec over its WebSocket data plane; `docs/azure-container-apps-sandboxes.md` records a live proof from 2026-07-08.

## Control plane

The worker control plane is already MCP. `packages/daemon/src/api/mcp-handler.ts` exposes authenticated Streamable HTTP at `/mcp/:podId`, requires a pod-scoped bearer token, creates a fresh server/transport per request, and preserves pending requests across calls. `packages/escalation-mcp/src/server.ts` exposes lifecycle, escalation, validation, memory, and dynamically profile-resolved action tools. `PodBridge` and `ActionEngine` remain the authority for policy, approval, execution, sanitization, and audit.

Pi has no built-in MCP client. Its extension API can dynamically register native Pi tools, so an Autopod-owned extension can adapt both variants already represented by `SpawnConfig.mcpServers`: Streamable HTTP and stdio. The extension should remain a transport adapter and must not duplicate control-plane policy.

## Pi process integration

Pi supports strict LF-delimited JSON RPC through `pi --mode rpc`. Commands and asynchronous events share stdout; command acceptance is not task completion. Relevant operations include prompt, steer/follow-up, abort, state inspection, and session control. A runtime controller therefore needs correlation IDs, strict framing, an RPC event parser, explicit completion criteria, and a fatal result for clean process exit without completed work.

Managed workers must load only the pinned Autopod extension and selected non-executable resources. Pi project trust and project-local executable extensions cannot become an alternate capability path inside an untrusted repository.

## Authentication

Autopod currently injects API keys through secret files and an agent shim that expands `*_FILE` pointers into standard environment variables. Pi can consume those provider variables.

Subscription credentials are CLI-specific. Claude Code credentials and Codex `auth.json` cannot be treated as Pi credentials. Pi stores OAuth entries in `~/.pi/agent/auth.json` under provider IDs such as `anthropic`, `openai-codex`, and `github-copilot`, and refreshes them in place. The existing desktop `ProfileAuthenticator`, CLI auth commands, encrypted profile/provider-account storage, and daemon credential read-back provide precedents.

The approved boundary is one Pi OAuth provider entry per credential owner. Login occurs in an isolated temporary Pi agent directory; Autopod extracts only the selected entry, stores it encrypted, reconstructs a one-entry container auth file, and persists only that owner's refreshed entry. A complete multi-provider auth bundle is never granted to a pod.

Pi's Anthropic OAuth uses billed extra usage rather than ordinary Claude plan limits. Claude Code remains supported for the subscription behavior the owner relies on.

## Product surfaces and blast radius

Adding `pi` crosses shared runtime/profile schemas, daemon runtime resolution and registration, provider environment/persistence, image generation, CLI profile/auth commands, and macOS desktop runtime/model/auth mappings. Existing runtime values are repeated in Swift and TypeScript. Full desktop support was explicitly included in the first deliverable.

## Decisions from the interview

- Pi runs as an RPC subprocess, not via SDK embedding.
- Claude Code, Codex, and Copilot remain first-class runtimes.
- Pi consumes the existing MCP control plane; no native replacement is introduced now.
- Both HTTP and stdio MCP transports receive parity.
- API-key and subscription-backed Pi providers are supported.
- Pi OAuth credentials are separated by provider/account.
- CLI and desktop support ship with the first usable release.
