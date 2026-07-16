# ADR-033: Add Pi as an Autopod-native worker beside vendor runtimes

## Status

Accepted

## Context

Autopod already supervises Claude Code, Codex, and Copilot through a common runtime interface and exposes worker capabilities through authenticated MCP. A provider-neutral worker can give Autopod deeper control over tools, events, and resource loading, but existing vendor runtimes remain necessary for their subscription authentication and mature integrations. Pi supports subprocess RPC and extensions but has no built-in MCP client.

## Decision

Add Pi as an additive `Runtime` implementation using a pinned RPC subprocess inside the existing container boundary. Ship an Autopod-owned Pi worker extension that adapts all configured HTTP and stdio MCP servers into Pi tools. Keep policy and privileged execution in the existing MCP/PodBridge/ActionEngine control plane.

Retain Claude Code, Codex, and Copilot as first-class sibling runtimes. Store Pi OAuth credentials as separate provider entries owned by a profile or provider account; never inject an owner's unrelated Pi providers into a pod. Managed Pi workers load the mandatory Autopod package and do not trust executable repository-local Pi resources.

## Consequences

Easier:

- Autopod gains a provider-neutral runtime it can shape and test directly.
- Existing sandbox, MCP, policy, approval, and audit infrastructure is reused.
- Vendor runtimes can remain available where their subscription behavior is preferable.

Harder:

- Autopod must maintain a strict Pi RPC adapter and a trusted MCP client extension.
- Pi OAuth capture, refresh persistence, model compatibility, and version pinning become supported contracts.
- Images and all profile surfaces must understand a fourth runtime.

Committed to:

- One control-plane implementation with transport adapters, not duplicate policy.
- MCP parity for HTTP and stdio servers.
- Fail-closed managed-worker startup when required control-plane tooling cannot initialize.
- Additive rollout with no automatic migration away from existing runtimes.
