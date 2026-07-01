---
title: "Route PR metadata and auto-commit through helpers"
touches:
  - packages/daemon/src/worktrees/pr-description-generator.ts
  - packages/daemon/src/worktrees/pr-description-generator.test.ts
  - packages/daemon/src/worktrees/auto-commit-message.ts
  - packages/daemon/src/worktrees/auto-commit-message.test.ts
  - packages/daemon/src/worktrees/pr-manager.ts
  - packages/daemon/src/worktrees/ado-pr-manager.ts
  - packages/daemon/src/pods/pod-manager.ts
does_not_touch:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/shared/src/types/pod.ts
---

## Task
Route PR title, PR narrative, and auto-commit message generation through the
shared container-first helper contract. Live pod containers should be used
while validation-time PR creation is still attached to a running pod.
Post-container retry paths may use the prompt-only helper container. Existing
daemon API and deterministic/template fallbacks remain last.

## Touches
- `packages/daemon/src/worktrees/pr-description-generator.ts`
- `packages/daemon/src/worktrees/pr-description-generator.test.ts`
- `packages/daemon/src/worktrees/auto-commit-message.ts`
- `packages/daemon/src/worktrees/auto-commit-message.test.ts`
- `packages/daemon/src/worktrees/pr-manager.ts`
- `packages/daemon/src/worktrees/ado-pr-manager.ts`
- `packages/daemon/src/pods/pod-manager.ts`

## Does not touch
- `packages/daemon/src/validation/local-validation-engine.ts`
- `packages/shared/src/types/pod.ts`

## Constraints
The daemon remains authoritative for push and PR creation. Do not move git or
PR authority into the pod. Pod activity should be emitted only when the final
output uses template or deterministic fallback. Intermediate helper failures
are logs.

## Test expectations
Extend the existing PR description and auto-commit tests to assert helper
precedence, stable fallback reason codes, invalid-output fallback, API
fallback, and post-container approval retry behavior.

## Risks / pitfalls
`pod-manager.ts` owns several PR creation paths. Cover validation pass,
revalidation pass, and approval retry behavior through existing test seams
instead of changing only the shared `pushAndCreatePr()` helper.

## Wrap-up
Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
