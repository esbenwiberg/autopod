# Handover: 02-local-reconciler

## Status
complete

## Summary
Created `local-reconciler.ts` that replaces the destructive orphan-kill block in `index.ts`. The reconciler mirrors the ACI reconciler pattern: it iterates all non-terminal local sessions and either recovers them (re-queues with `recoveryWorktreePath` set if the worktree still exists on disk), kills them (if the worktree is gone), finishes mid-kill sessions, or skips queued ones. Old containers are killed best-effort before recovery. The state machine is bypassed for the `running -> queued` recovery transition via direct `sessionRepo.update()`, documented in code. Recovery is non-blocking -- the daemon starts regardless of reconciliation outcome.

## Deviations from Plan
- Used `ContainerManager` interface (not `DockerContainerManager` class) as the brief's codebase context section recommended, keeping it testable.
- Named the dependency field `containerManager` (not `dockerContainerManager`) to match the interface-based approach.

## Contract Changes
All contracts honored as specified. The `LocalReconcilerDependencies` interface uses `containerManager: ContainerManager` instead of `dockerContainerManager: DockerContainerManager` -- this is compatible and more flexible.

## Downstream Impacts
- Brief 03 (session-manager recovery): The reconciler sets `recoveryWorktreePath` and resets status to `queued`. The session manager's `processSession()` needs to check `recoveryWorktreePath` and skip worktree creation when it's set, binding the existing worktree instead.
- Brief 04 (tests): The reconciler is a pure async function with injected deps -- straightforward to unit test with mocked sessionRepo, eventBus, containerManager, and enqueueSession.

## Discovered Constraints
No new constraints discovered.

## Files Changed
| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/sessions/local-reconciler.ts` | create | New reconciler module with `reconcileLocalSessions()` export |
| `packages/daemon/src/index.ts` | modify | Replaced orphan-kill block (lines 349-385) with non-blocking local reconciler call |

## Acceptance Criteria Status
- [x] Daemon starts without killing recoverable local sessions
- [x] Sessions with surviving worktrees are re-queued (status -> queued)
- [x] Sessions with missing worktrees are killed (current behavior preserved)
- [x] Sessions in `killing` state are finished to `killed`
- [x] Old containers are cleaned up (best-effort)
- [x] `recoveryWorktreePath` is set on re-queued sessions
- [x] Events emitted for status changes (TUI stays in sync)
- [x] Recovery is non-blocking -- daemon starts regardless of reconciliation outcome
- [x] Log output clearly indicates which sessions were recovered vs killed
