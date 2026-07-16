# Plan — Autopod-native Pi worker

## Overview

Introduce Pi as Autopod's native, provider-neutral worker while retaining every existing vendor CLI runtime. Build the trusted MCP bridge first, add strict Pi RPC lifecycle and provider credential handling second, then expose the runtime through images, CLI/profile surfaces, and desktop.

## Desired end state

A profile selecting `runtime: pi` launches a pinned Pi CLI in either Docker or Azure Sandboxes, connects to the existing pod-scoped MCP control plane, streams normalized Autopod events, supports follow-up/resume/abort/suspend, and uses either API keys or a least-privilege single-provider Pi OAuth credential. Existing profiles continue launching their previous CLIs.

## What we are not doing

- Replacing or deprecating Claude Code, Codex, or Copilot.
- Adding a second implementation of approvals, actions, validation, or memory.
- Replacing MCP with a Pi-native control-plane protocol.
- Changing Azure sandbox provisioning or its security boundary.
- Automatically migrating existing profiles.
- Loading arbitrary repository-provided Pi extensions in managed workers.

## Implementation approach

1. Create a small `@autopod/pi-worker` Pi package. Adapt configured HTTP and stdio MCP servers into dynamically registered Pi tools, preserve schemas/results, forward headers, support cancellation and long calls, reject collisions, and fail closed when the required Autopod server cannot initialize.
2. Add a strict Pi RPC controller/runtime. Start Pi through existing streaming exec, parse LF-only JSON records, correlate responses, map events, retain session state, and refuse false completion. Reuse existing liveness/grace behavior.
3. Add Pi-specific credential material to existing credential owners. Capture one provider entry in an isolated directory; inject and persist only that entry. Keep existing CLI-specific subscription formats intact.
4. Install pinned Pi and the trusted worker package in generated images. Extend shared/profile/runtime resolution and CLI commands without changing defaults.
5. Add desktop runtime, compatible model/provider behavior, and Pi authentication using the existing Terminal-based authentication pattern.

## Checkpoints

- Gate 1: trusted MCP bridge contract and tests.
- Gate 2: runtime and authentication lifecycle consume Gate 1.
- Gate 3: image/CLI/profile enablement consumes Gate 2.
- Gate 4: desktop enablement consumes the stable profile/auth contract from Gate 3.

## Test strategy

- MCP fixtures with different tools and transports must register different tools and forward distinct arguments/results; a missing required server or duplicate name must fail.
- RPC fixtures containing text, tool, error, and completion events must emit distinguishable `AgentEvent` variants. Empty or status-only output must not complete.
- Follow-up must retain the session ID; abort and suspend must have different state outcomes.
- Two Pi provider accounts must generate different one-entry auth files. Refreshing one must not modify another.
- Image generation must contain pinned Pi while retaining all existing CLIs.
- CLI/profile tests must accept Pi but preserve legacy defaults and runtime choices.
- Desktop tests must prove selecting Pi changes compatibility/default behavior and that Pi login stores only the selected provider entry.

## Risks and pitfalls

- Pi RPC responses acknowledge commands before eventual task failure or completion.
- Generic line readers violate Pi's strict LF framing for JSON strings containing Unicode separators.
- OAuth refresh writes can race across concurrent pods; ownership-aware persistence must serialize or compare lineage.
- MCP human approvals can hold a request open for an hour.
- Runtime/package upgrades can change OAuth or event shapes, so versions must be pinned and tested.
- Azure warm images must contain both Pi and the extension before sandbox pods can select the runtime.
