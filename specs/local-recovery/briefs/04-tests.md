# Brief: Tests

## Objective
Comprehensive test coverage for the local recovery feature: reconciler logic,
processSession recovery path, and recovery context generation.

## Dependencies
- All prior briefs (01, 02, 03)

## Blocked By
Briefs 01, 02, 03.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/sessions/local-reconciler.test.ts` | create | Unit tests for reconciler |
| `packages/daemon/src/sessions/recovery-context.test.ts` | create | Unit tests for prompt building |
| `packages/daemon/src/sessions/session-manager.test.ts` | modify | Add recovery-mode test cases |

## Implementation Notes

### local-reconciler.test.ts

Test scenarios:
1. **Session with surviving worktree** → re-queued with `recoveryWorktreePath` set
2. **Session with missing worktree** → killed
3. **Session in `killing` state** → finished to `killed`
4. **Session in `queued` state** → skipped (already queued)
5. **Old container killed** (best-effort — test both success and failure)
6. **Multiple sessions** — mix of recoverable and unrecoverable
7. **No orphaned sessions** → noop, returns empty result
8. **ACI sessions ignored** — only local sessions processed

Mock `fs.access` to control worktree existence. Mock `dockerContainerManager`
for container operations.

### recovery-context.test.ts

Test scenarios:
1. **Branch with commits and no uncommitted changes** → prompt includes log
2. **Branch with commits and uncommitted diff** → prompt includes both
3. **Empty branch (no commits)** → prompt says "no commits yet"
4. **Git commands fail** → graceful fallback (empty strings)

Mock `execFileAsync` for git operations.

### session-manager.test.ts additions

Add to existing test suite using `createTestContext()`:

1. **processSession with recoveryWorktreePath** → skips worktree creation,
   spawns container with existing path
2. **processSession recovery + Claude runtime** → calls `runtime.resume()`
   with continuation prompt
3. **processSession recovery + Copilot runtime** → calls `runtime.spawn()`
   with recovery task
4. **processSession recovery + resume failure** → falls back to fresh spawn
5. **recoveryWorktreePath cleared** after recovery starts

Use existing mock patterns from `mock-helpers.ts`. The worktree manager mock
should NOT be called for `.create()` during recovery tests.

## Acceptance Criteria

- [ ] All reconciler scenarios tested (recover, kill, skip)
- [ ] Recovery context prompt generation tested with various git states
- [ ] processSession recovery path tested for all 3 runtimes
- [ ] Resume failure + fallback tested
- [ ] All tests pass: `npx pnpm --filter @autopod/daemon test`
- [ ] No regressions in existing tests

## Estimated Scope
Files: 3 | Complexity: medium
