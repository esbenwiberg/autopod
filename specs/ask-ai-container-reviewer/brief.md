---
title: "Route escalation AI through live pod containers"
touches:
  - packages/daemon/src/pods/pod-bridge-impl.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/index.ts
  - packages/daemon/src/pods/pod-bridge-validation.test.ts
  - packages/escalation-mcp/src/tools/escalation-tools.test.ts
does_not_touch:
  - packages/daemon/src/validation/advisory-browser-qa-runner.ts
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/runtimes/run-claude-cli.ts
  - packages/escalation-mcp/src/tools/validate-in-browser.ts
  - packages/escalation-mcp/src/tools/ask-ai.ts
  - packages/escalation-mcp/src/tools/ask-human.ts
  - packages/shared/src/types/profile.ts
---

## Task
Make the agent MCP `ask_ai` reviewer and every `ask_human` AI-routing path use a
reviewer CLI executed inside the live pod container. When no live container exists, return a
clear soft-failure response instead of trying any daemon-side model SDK fallback.

## Why
Max/Pro profiles can authenticate through the pod/container CLI route while daemon-side
Anthropic SDK calls can fail without separate billing API credentials. Validation review
already has a working container-backed auth path; escalation AI needs the same subscription-safe
behavior without changing escalation semantics.

## Touches
Modify `packages/daemon/src/pods/pod-bridge-impl.ts` for the reviewer dispatch, and touch
`packages/daemon/src/pods/pod-manager.ts` plus `packages/daemon/src/index.ts` only as needed to
provide the bridge with pod-manager-owned refreshed provider exec env. Update
`packages/daemon/src/pods/pod-bridge-validation.test.ts` and
`packages/escalation-mcp/src/tools/escalation-tools.test.ts` for focused proof.

## Does not touch
Do not edit `packages/daemon/src/validation/advisory-browser-qa-runner.ts`,
`packages/daemon/src/validation/local-validation-engine.ts`,
`packages/daemon/src/runtimes/run-claude-cli.ts`,
`packages/escalation-mcp/src/tools/validate-in-browser.ts`,
`packages/escalation-mcp/src/tools/ask-ai.ts`,
`packages/escalation-mcp/src/tools/ask-human.ts`, or
`packages/shared/src/types/profile.ts`.

## Constraints
Keep architecture strict: do not move or extract helper code from advisory browser QA just to
share its private reviewer wrapper. The bridge may use the same pattern, but advisory browser QA
ownership stays unchanged.

The AI scope is the `callReviewerModel(...)` path used by `ask_ai` and the two `ask_human` AI
routes. `validate_in_browser` also calls that bridge method today, but browser validation is a
non-goal for this brief.

The no-container behavior must be explicit and soft: `callReviewerModel(...)` should return
`AI review failed: AI reviewer requires a live pod container` when the pod has no usable live
container. The existing MCP wrappers may still prepend their normal auto-routing text.

Pass refreshed provider exec env to the in-container reviewer call. `pod-manager.ts` already uses
`getResumeEnv(pod)` for validation reviewers, and the inline comment says Max and Foundry token
auth need fresh env on resume; escalation AI should not rely only on stale files already present
inside the container.

Preserve escalation persistence semantics and limits. Do not change escalation record creation,
resolution, rate limits, max call policy, or human wait behavior.

## Skills to reference
None detected.

## Test expectations
Update `packages/daemon/src/pods/pod-bridge-validation.test.ts` so `callReviewerModel(...)` for a
Max/Pro profile with a live container executes a Claude CLI reviewer through
`/run/autopod/agent-shim.sh` inside that container and does not call
`createProfileAnthropicClient(...)` or require daemon `ANTHROPIC_API_KEY`.

Also cover that the bridge passes refreshed provider exec env into the in-container reviewer, and
that a pod without a live container returns the exact soft-failure message
`AI review failed: AI reviewer requires a live pod container`.

Update `packages/escalation-mcp/src/tools/escalation-tools.test.ts` so both `ask_human` AI
routes are covered: series unattended mode and timeout fallback should include their existing
auto-routing prefix while surfacing the bridge's AI response. Keep `ask_ai` rate-limit and
escalation persistence behavior unchanged.

## Risks / pitfalls
`getResumeEnv(...)` is currently private to `pod-manager.ts`, while the bridge is created in
`packages/daemon/src/index.ts`. Prefer a narrow dependency or method surface over broadening
validation ownership.

Avoid daemon-side fallback for every profile, including legacy Anthropic profiles with
`ANTHROPIC_API_KEY`. The contract is live-container-only for escalation AI.

## Wrap-up
Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
