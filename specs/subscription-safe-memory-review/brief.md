---
title: "Make automatic memory review subscription-safe"
touches:
  - packages/daemon/src/providers/memory-reviewer.ts
  - packages/daemon/src/providers/memory-reviewer.test.ts
  - packages/daemon/src/pods/memory-selector.ts
  - packages/daemon/src/pods/memory-selector.test.ts
  - packages/daemon/src/pods/memory-candidate-recorder.ts
  - packages/daemon/src/pods/memory-candidate-recorder.test.ts
  - packages/daemon/src/pods/memory-extraction.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/pods/system-instructions-generator.ts
  - packages/daemon/src/pods/system-instructions-generator.test.ts
  - packages/daemon/src/validation/review-container-runner.ts
  - packages/daemon/src/validation/review-container-runner.test.ts
does_not_touch:
  - packages/shared/src/types/profile.ts
  - packages/shared/src/types/pod.ts
  - packages/desktop/
  - packages/escalation-mcp/
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/pod-bridge-impl.ts
---

## Task

Make automatic memory ranking before pod start and automatic memory extraction after pod
outcome subscription-safe. Both paths should prefer the pod/container reviewer path when the
container has the same provider auth that the agent uses, fall back to the existing daemon
reviewer when available, and otherwise degrade with deterministic evidence instead of looking
like "no relevant memory" or "no lesson learned."

Do not change `memory_suggest`; agent-initiated suggestions already work.

## Why

`memory_suggest` is fine because it is an MCP call from the running agent. The broken paths are
daemon-side automatic reviewer calls through `createProfileMemoryReviewer` /
`createProfileAnthropicClient`, which can fail for Max/Pro-only or ChatGPT-auth profiles even
when the pod itself can use the subscription auth.

ADR-027 commits to fail-soft memory learning and says reviewer availability must be visible so
`memory was unavailable` does not look like `memory was irrelevant`.

## Touches

- `packages/daemon/src/providers/memory-reviewer.ts` and
  `packages/daemon/src/providers/memory-reviewer.test.ts` - keep or extend the reviewer
  abstraction so automatic memory review can use container-first, daemon-fallback behavior
  without duplicating prompt parsing.
- `packages/daemon/src/validation/review-container-runner.ts` and
  `packages/daemon/src/validation/review-container-runner.test.ts` - create a small reusable
  container reviewer helper if extracting the existing advisory browser QA helper is the
  cleanest path. It should route Claude-style providers through Claude and OpenAI-style
  providers through Codex, using the existing `/run/autopod/agent-shim.sh` pattern.
- `packages/daemon/src/pods/memory-selector.ts` and
  `packages/daemon/src/pods/memory-selector.test.ts` - rank approved memory through the
  provider-neutral reviewer abstraction, keep deterministic fallback, and preserve selected /
  injected usage rows.
- `packages/daemon/src/pods/memory-candidate-recorder.ts`,
  `packages/daemon/src/pods/memory-candidate-recorder.test.ts`, and
  `packages/daemon/src/pods/memory-extraction.ts` - run extraction through the same
  container-first, daemon-fallback reviewer path and continue recording extraction attempts.
- `packages/daemon/src/pods/pod-manager.ts` and
  `packages/daemon/src/pods/pod-manager.test.ts` - prepare provider credentials and the agent
  shim before memory ranking, emit visible pod activity when ranking falls back, and give
  extraction a bounded pre-cleanup chance to use the live container.
- `packages/daemon/src/pods/system-instructions-generator.ts` and
  `packages/daemon/src/pods/system-instructions-generator.test.ts` - preserve or tighten the
  `Relevant Memory` unavailable-reason text so injected context remains explicit.

## Does not touch

- `packages/shared/src/types/profile.ts` and `packages/shared/src/types/pod.ts` - do not add a
  new profile field, pod status, or shared config field in this brief.
- `packages/desktop/` - no new desktop UI. Use existing pod activity, memory usage, and
  extraction attempt evidence.
- `packages/escalation-mcp/` and `packages/daemon/src/pods/pod-bridge-impl.ts` - do not change
  `memory_suggest` behavior or MCP memory tool contracts.
- `packages/daemon/src/db/migrations/` - no schema migration should be needed. If a durable
  schema change becomes necessary, stop and recommend `/plan-feature`; if it is a profile field,
  also reference `/add-profile-field`.

## Constraints

- ADR-027 says: "Fail-soft fallback reasons must be visible so \"memory was unavailable\" does
  not look like \"memory was irrelevant.\""
- Automatic ranking currently runs in `pod-manager.ts` after the container is spawned but before
  provider credential files and `/run/autopod/agent-shim.sh` are written. Move or reuse setup so
  the container reviewer path is ready before ranking, then generate system instructions.
- Extraction currently listens to `pod.completed` and `pod.status_changed` events. Several
  completion paths clean up the container before emitting `pod.completed`; give live containers
  one bounded pre-cleanup extraction opportunity where possible, but do not make memory learning
  a lifecycle blocker.
- Use the existing memory reviewer timeout scale: selection and extraction already use roughly
  20s reviewer timeouts. Container-first extraction may delay cleanup only within a bounded
  window; timeout/failure must fall through to daemon fallback or unavailable evidence.
- Keep daemon reviewer fallback for profiles where it already works, including API-key Anthropic,
  Foundry Anthropic, Foundry OpenAI, and daemon OpenAI API key cases.
- For Max/Pro and ChatGPT-auth OpenAI-style profiles, the container reviewer path is the primary
  subscription-safe path because it uses the same pod CLI auth files and shim as the agent.
- If ranking has deterministic candidates but both container and daemon reviewers are
  unavailable, select from deterministic keyword prefiltering, record selected/injected usage
  rows, emit pod activity with the unavailable reason, and include the reason in `Relevant
  Memory`.
- If extraction crosses the lesson-potential threshold but reviewers are unavailable, record a
  `memory_extraction_attempts` row with `status: reviewer_unavailable`, the stable reason, score,
  and signals. Do not create a memory candidate and do not alter pod lifecycle.

## Skills to reference

- None - this does not add a `Profile` field, pod status, migration, shared MCP contract, or
  desktop surface.

## Test expectations

Update `memory-selector.test.ts` to prove reviewer ranking can use the provider-neutral
container-first reviewer result, and that reviewer-unavailable ranking still selects
deterministic fallback memories, records selected/injected usage rows, and returns a clear
unavailable reason.

Update `pod-manager.test.ts` to prove provider credentials and `/run/autopod/agent-shim.sh` are
prepared before memory ranking when a container reviewer is needed, and to prove ranking fallback
emits a `pod.agent_activity` status that names the unavailable reason and deterministic fallback.

Update `memory-candidate-recorder.test.ts` to prove high-signal extraction prefers a live
container reviewer, falls back to the daemon reviewer when the container reviewer is unavailable,
and records `reviewer_unavailable` when both are unavailable. Include the bounded timeout path.

Add or update reviewer helper tests, likely in `review-container-runner.test.ts` and
`memory-reviewer.test.ts`, to cover provider routing: Max/Pro through Claude in the container,
OpenAI/Foundry OpenAI through Codex in the container, Foundry Anthropic via Claude/direct fallback,
and Copilot as explicitly unavailable for automatic memory review.

Keep `system-instructions-generator.test.ts` covering `Relevant Memory` fallback text so the
agent sees that deterministic keyword fallback was used.

## Risks / pitfalls

- Reordering provider setup in `pod-manager.ts` is the riskiest part. Avoid duplicating secret
  writes or widening secret exposure; reuse the existing secret-file plus shim pattern.
- ACI `execInContainer` is less capable than Docker exec. If container review cannot be made
  reliable for ACI in this brief, record a clear unavailable reason and rely on daemon fallback.
- Do not turn automatic memory learning into a cleanup or completion blocker. The worst case
  should be visible unavailability evidence, not a stuck pod.
- The existing advisory browser QA file contains container reviewer precedent, but it is large.
  Extract only the small generic runner needed for memory review if reuse is warranted.

## Wrap-up

Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
