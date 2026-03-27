# Handover: Brief 03 — processSession() Recovery Path

## What was done

### New file: `packages/daemon/src/sessions/recovery-context.ts`
- `buildContinuationPrompt(session, worktreePath)` — generates a context-rich prompt with git log and uncommitted diff for Claude `--resume`
- `buildRecoveryTask(session, worktreePath)` — wraps the original task with recovery context for non-Claude runtimes
- `RecoveryContext` interface exported (matches contracts.md)
- Git output capped at 8KB to avoid blowing up prompt context

### Modified: `packages/daemon/src/sessions/session-manager.ts`

**Worktree phase (early in `processSession()`):**
- `isRecovery` flag set from `!!session.recoveryWorktreePath` before provisioning
- When recovering: skips `worktreeManager.create()`, reuses `recoveryWorktreePath`, derives `bareRepoPath` via `git rev-parse --git-common-dir`
- Clears `recoveryWorktreePath` in DB immediately after capturing the path
- Normal (non-recovery) path completely untouched

**Agent spawn phase:**
- Claude + `claudeSessionId` → rehydrates `ClaudeRuntime.claudeSessionIds` map via `setClaudeSessionId()`, then calls `runtime.resume()` with continuation prompt
- If `runtime.resume()` throws → falls back to `runtime.spawn()` with `buildRecoveryTask()`
- Non-Claude recovery (or Claude without `claudeSessionId`) → `runtime.spawn()` with `buildRecoveryTask()`
- Normal path unchanged

**Helper added:**
- `deriveBareRepoPath(worktreePath)` — uses `git rev-parse --git-common-dir` to find the bare repo from an existing worktree

## Design decisions

- Used `'setClaudeSessionId' in runtime` duck-typing check before casting to `ClaudeRuntime` — avoids tight coupling while still being safe
- `recoveryWorktreePath` cleared immediately after capture (not after container start) to prevent stale recovery flags if provisioning fails and session is retried
- Recovery context uses `--stat` for diff (not full diff) to keep prompt size reasonable

## What's next (Brief 04+)

- Integration/e2e tests for the recovery path
- Smoke test: daemon restart with active sessions → verify sessions resume correctly
- Metrics/observability: track recovery success/failure rates

## Test status

- `npx pnpm build` passes
- `npx pnpm test`: 716 passed, 5 failed (all 5 failures pre-existing, unrelated to this change)
