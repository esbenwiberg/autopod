---
title: "Build the dedicated-account system decision sandbox"
touches:
  - packages/daemon/src/system-sandbox/
  - packages/daemon/src/providers/env-builder.ts
  - packages/daemon/src/providers/credential-persistence.ts
  - packages/daemon/src/providers/auth-resolution.ts
  - packages/daemon/src/runtimes/provider-error-classifier.ts
  - packages/daemon/src/index.ts
  - templates/system/Dockerfile.decision
  - scripts/
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/podsitter/podsitter-service.ts
  - packages/daemon/src/api/routes/podsitter.ts
  - packages/cli/
  - packages/desktop/
require_sidecars: []
---

## Task

Create a reusable daemon-owned system decision runner that launches a repo-free restricted Docker or Azure sandbox, authenticates exactly one provider CLI from the configured dedicated provider account, obtains one schema-validated Podsitter decision, persists credential rotations safely, and always tears the sandbox down. Add the pinned hosted system decision image/build path.

## Motivation

Subscription-backed provider auth cannot be assumed daemon-callable. Existing `container-reviewer-runner.ts` can use OAuth only when a target pod still has a live container, which is unreliable and would trust an agent-modified environment. Podsitter requires an independent pristine sandbox that preserves the OAuth boundary without receiving operational privileges.

## Repository findings

- `templates/base/Dockerfile.node22` already installs Claude, Codex, Copilot, and Pi CLIs, but profile warm images clone repository content and must not be used for system decisions.
- `ContainerManager.spawn()` supports volume-free restricted Docker and Azure sandbox execution plus buffered exec, which is sufficient for one-shot inference.
- `buildProviderEnv()` currently starts from a `Profile`; extract or add an account-first path rather than manufacturing a fake profile.
- `credential-persistence.ts` already serializes refresh/readback by `CredentialOwner`, but its public helpers still require a profile name/store. Preserve existing pod callers while adding direct provider-account ownership.
- `provider-error-classifier.ts` already distinguishes transient, definitive quota, auth, and provider-unavailable evidence.

## Approved approach

Implement the `SystemDecisionRunner` boundary described in `design.md`. Input includes decision id, dedicated provider account id, runtime/model/reasoning effort, bounded prompt, expected decision schema/version, execution target, and timeout. Output is a parsed decision plus bounded telemetry or a typed sanitized failure classification.

Use one daemon-owned system image with all supported CLIs. Hosted sandbox execution requires a configured ACR-qualified pinned tag/digest and must fail visibly when absent. Local Docker may use the equivalent local image. Never use a profile warm image.

Provider account compatibility must be validated against the provider catalog. Account auth preparation and readback must support MAX, OpenAI/Codex ChatGPT, Pi OAuth, Copilot, Foundry, API-key, and other currently runnable account forms as their compatible runtime permits. There is no daemon-SDK or target-account fallback.

Spawn with no volumes/ports, no daemon gateway, no MCP config/token, and restricted egress containing only provider-required hosts. Write normal files and `0400` secret files, invoke a no-tools one-shot command, parse the runtime envelope, and validate strict decision JSON. Allow one bounded schema-repair retry in the same sandbox; it is not an operational action.

Record run lifecycle through the repositories from Brief 01. Kill in `finally`; add startup/periodic cleanup for leaked active system runs without creating normal Pod rows.

## Scope boundaries

Do not collect pod evidence, start the Podsitter attention loop, execute PodManager actions, or expose public routes. Do not link the dedicated account to a profile. Do not give the sandbox arbitrary tools or a repository/worktree.

## Constraints

- Secrets must not appear in container creation env, logs, decisions, errors, or persisted run rows.
- The runtime command must disable configured tools/MCP/project resources and be non-interactive.
- The system image must be repo-free and digest-pinnable.
- Credential readback must target only the configured provider account and preserve MAX lineage guards.
- Cleanup failure is durable and retryable; inference success must not hide a leaked sandbox.
- Runtime/provider errors must be sanitized before persistence and classify rate limits separately from definitive quota.
- A malformed decision remains a model-output failure, not an implicit action.

## Test expectations

Use mocked ContainerManagers and provider accounts to prove spawn isolation, provider host allowlists, account-only auth, all compatible runtime adapters, strict output parsing, bounded repair, credential readback, and cleanup on success/failure/timeout. Prove startup reaping of a persisted leaked run. Verify provider-limit evidence preserves category and retry/reset information.

## Required-fact sanity

- A runner that mounts `/workspace`, supplies an MCP/daemon token, or allows unrestricted egress must fail `fact-system-sandbox-isolation`.
- A runner that uses a fake profile or updates the wrong credential owner must fail `fact-dedicated-account-oauth-lifecycle`.
- A runner accepting prose or an unknown action as a decision must fail `fact-strict-decision-output`.
- A runner without `finally` cleanup and durable reaping must fail `fact-system-sandbox-cleanup`.

## Risks

CLI no-tools flags and output envelopes differ by runtime. Keep adapters explicit and test each supported runtime. Azure buffered exec behavior differs from Docker; avoid assumptions about streaming or local bind mounts. Provider OAuth may rotate even on a failed inference, so attempt readback before cleanup whenever safe.

## Wrap-up

Before finishing:
1. Run focused daemon tests and image-generation checks.
2. Verify no secret-bearing values are logged or persisted.
3. Run the profile finish prompt if configured.
4. Commit and push.
