---
title: "Add shared container-first helper contract"
touches:
  - packages/daemon/src/providers/container-first-llm-helper.ts
  - packages/daemon/src/providers/container-first-llm-helper.test.ts
  - packages/daemon/src/validation/container-reviewer-runner.ts
  - packages/daemon/src/validation/review-codex-runner.ts
does_not_touch:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/pods/pod-manager.ts
---

## Task
Add a shared daemon helper contract for best-effort LLM tasks. It must try a
live pod container first when context is available, then a prompt-only helper
container when the caller allows post-container execution, then the caller's
existing daemon API or deterministic fallback. The result must include output,
token usage when available, selected stage, and stable fallback metadata.

## Touches
- `packages/daemon/src/providers/container-first-llm-helper.ts`
- `packages/daemon/src/providers/container-first-llm-helper.test.ts`
- `packages/daemon/src/validation/container-reviewer-runner.ts`
- `packages/daemon/src/validation/review-codex-runner.ts`

## Does not touch
- `packages/daemon/src/validation/local-validation-engine.ts`
- `packages/daemon/src/pods/pod-manager.ts`

## Constraints
Read `design.md` Contracts before coding. Preserve existing validation reviewer
behavior: this contract is for best-effort helpers, not blocking task-review
pass/fail. Do not mount or read repo files in the helper contract; callers
provide prompt context.

## Test expectations
Add focused unit coverage for stage ordering, fallback metadata, token usage
propagation, and provider/runtime routing. Tests must assert the daemon fallback
is not constructed when live or helper-container execution succeeds.

## Wrap-up
Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
