---
title: "Add prompt-only helper container runner"
touches:
  - packages/daemon/src/pods/helper-container-runner.ts
  - packages/daemon/src/pods/helper-container-runner.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/interfaces/container-manager.ts
  - packages/daemon/src/containers/sandbox-container-manager.ts
does_not_touch:
  - packages/daemon/src/worktrees/pr-description-generator.ts
  - packages/daemon/src/worktrees/auto-commit-message.ts
---

## Task
Add the short-lived helper-container execution surface used by the shared
helper contract. The runner must support both `local` and `sandbox` execution
targets, write prompt-only input, inject reviewer/provider auth, execute the
selected Claude/Codex helper, collect token usage when available, and clean up
the helper container.

## Touches
- `packages/daemon/src/pods/helper-container-runner.ts`
- `packages/daemon/src/pods/helper-container-runner.test.ts`
- `packages/daemon/src/pods/pod-manager.ts`
- `packages/daemon/src/interfaces/container-manager.ts`
- `packages/daemon/src/containers/sandbox-container-manager.ts`

## Does not touch
- `packages/daemon/src/worktrees/pr-description-generator.ts`
- `packages/daemon/src/worktrees/auto-commit-message.ts`

## Constraints
Helper containers are prompt-only. Do not mount or copy the repo workspace.
Reuse the `ContainerManager` interface so Docker and sandbox behavior stay
equivalent. Reuse the same reviewer exec env and secret-file patterns that
live pod reviewers use.

## Test expectations
Mock `ContainerManager.spawn`, `writeFile`, `execInContainer`, and `kill` for
local and sandbox targets. Assert spawn config has no worktree volume/copy or
preview sidecar shape. Assert cleanup runs in success and failure paths.

## Wrap-up
Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
