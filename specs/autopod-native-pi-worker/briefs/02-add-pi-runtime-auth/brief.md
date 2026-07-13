---
title: "Add Pi RPC runtime and credential lifecycle"
touches:
  - packages/shared/src/types/runtime.ts
  - packages/shared/src/types/model-provider.ts
  - packages/shared/src/schemas/profile.schema.ts
  - packages/daemon/src/runtimes/
  - packages/daemon/src/providers/
  - packages/daemon/src/index.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/test-utils/mock-helpers.ts
does_not_touch:
  - packages/daemon/src/containers/
  - packages/escalation-mcp/
  - packages/desktop/
require_sidecars: []
---

## Task

Add Pi as an additive Autopod runtime using a strict RPC subprocess over the existing streaming container interface. Normalize Pi events, preserve session identity for follow-up/resume, distinguish abort from suspend, reject false completion, and integrate the trusted worker package from Brief 01. Add least-privilege Pi OAuth entry construction, injection, ownership-aware refresh persistence, and API-key compatibility without changing existing runtime credentials.

## Research summary

Claude and Codex runtimes establish process, recovery, liveness, and false-completion patterns. Pi RPC mixes correlated command responses with asynchronous events and requires LF-only framing. Pi OAuth entries are provider-specific and refreshed in `~/.pi/agent/auth.json`; existing vendor CLI credential files are not portable. Read `research.md`, `plan.md`, and the parent handoff before coding.

## Plan

Extend the shared runtime/provider contracts, implement a dedicated RPC controller/parser and `PiRuntime`, register it centrally, and reuse stream guards. Add a provider-entry credential shape that reconstructs a one-entry Pi auth file and persists only refreshed data for the same owner/provider. Explicitly load the trusted extension and suppress untrusted executable project resources.

## Checkpoints

1. Add shared contracts and parser fixtures.
2. Implement RPC process lifecycle and normalized event mapping.
3. Implement resume, abort, suspend, and false-completion handling.
4. Add one-entry auth injection and owner-aware refresh persistence.
5. Register Pi without changing legacy runtime resolution.

## Touches

- `packages/shared/src/types/runtime.ts`
- `packages/shared/src/types/model-provider.ts`
- `packages/shared/src/schemas/profile.schema.ts`
- `packages/daemon/src/runtimes/`
- `packages/daemon/src/providers/`
- `packages/daemon/src/index.ts`
- `packages/daemon/src/pods/pod-manager.ts`
- `packages/daemon/src/test-utils/mock-helpers.ts`

## Does not touch

- `packages/daemon/src/containers/`
- `packages/escalation-mcp/`
- `packages/desktop/`

## Constraints

Follow `design.md` contracts and ADR-033. Use strict LF splitting rather than generic line readers. A prompt response only acknowledges acceptance. Do not mark completion without terminal agent evidence. Keep `Runtime` unchanged except for the additive type value. Preserve existing credentials and defaults.

## Test expectations

Add parser/controller fixtures for response correlation, Unicode separators inside JSON strings, text/tool/error/completion mapping, malformed records, and status-only exit. Add runtime tests for initial prompt, same-session follow-up, abort cleanup, suspend preservation, trusted extension flags, and process failure. Add provider tests proving two owners produce different one-entry auth files and refreshing one cannot update the other.

## Risks / pitfalls

RPC stdin remains open while events stream. Session replacement and follow-up are not equivalent. OAuth refresh races need the same ownership discipline as existing persistence. Never log auth entries, prompts, MCP headers, or secret-file contents.

## Wrap-up

Before finishing:
1. Run the profile finish prompt if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
