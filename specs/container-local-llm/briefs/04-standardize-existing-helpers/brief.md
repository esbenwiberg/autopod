---
title: "Standardize existing best-effort helpers"
touches:
  - packages/daemon/src/providers/memory-reviewer.ts
  - packages/daemon/src/providers/memory-reviewer.test.ts
  - packages/daemon/src/validation/advisory-browser-qa-runner.ts
  - packages/daemon/src/validation/advisory-browser-qa-runner.test.ts
  - packages/daemon/src/pods/pod-bridge-impl.ts
  - packages/daemon/src/pods/pod-bridge-validation.test.ts
does_not_touch:
  - packages/daemon/src/worktrees/pr-description-generator.ts
  - packages/daemon/src/validation/local-validation-engine.ts
---

## Task
Migrate the existing best-effort helper surfaces for memory selection,
advisory browser QA, and MCP ask_ai/browser-script generation to the shared
helper contract where behavior permits. Preserve their current fail-soft
semantics and document any local wrapper that remains necessary.

## Touches
- `packages/daemon/src/providers/memory-reviewer.ts`
- `packages/daemon/src/providers/memory-reviewer.test.ts`
- `packages/daemon/src/validation/advisory-browser-qa-runner.ts`
- `packages/daemon/src/validation/advisory-browser-qa-runner.test.ts`
- `packages/daemon/src/pods/pod-bridge-impl.ts`
- `packages/daemon/src/pods/pod-bridge-validation.test.ts`

## Does not touch
- `packages/daemon/src/worktrees/pr-description-generator.ts`
- `packages/daemon/src/validation/local-validation-engine.ts`

## Constraints
Memory stays daemon-curated. Advisory QA remains advisory and fail-soft. MCP
ask_ai and browser-script generation still require a live pod container; do not
invent post-container behavior for MCP tools.

## Test expectations
Extend the existing memory, advisory, and pod-bridge tests. Assert the shared
helper path is invoked first, deterministic fallback records are preserved, and
current live-container requirements for MCP helper calls do not loosen.

## Wrap-up
Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
