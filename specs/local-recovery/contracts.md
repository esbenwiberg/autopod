# Interface Contracts

## Session Type Extension

```typescript
// Added to Session in packages/shared/src/types/session.ts
interface Session {
  // ... existing fields ...

  /**
   * Set by the local reconciler when a session is re-queued for recovery.
   * When present, processSession() skips worktree creation and reuses this path.
   * Cleared after successful recovery (reset to normal worktreePath).
   */
  recoveryWorktreePath: string | null;
}
```

## DB Migration

```sql
-- New column on sessions table
ALTER TABLE sessions ADD COLUMN recovery_worktree_path TEXT DEFAULT NULL;
```

## Local Reconciler Interface

```typescript
// packages/daemon/src/sessions/local-reconciler.ts
export interface LocalReconcilerDependencies {
  sessionRepo: SessionRepository;
  eventBus: EventBus;
  dockerContainerManager: DockerContainerManager;
  enqueueSession: (sessionId: string) => void;
  logger: Logger;
}

export function reconcileLocalSessions(
  deps: LocalReconcilerDependencies,
): Promise<ReconcileResult>;

export interface ReconcileResult {
  recovered: string[];   // session IDs re-queued for recovery
  killed: string[];      // session IDs killed (unrecoverable)
  skipped: string[];     // session IDs skipped (already terminal)
}
```

## Recovery Context for Agent Spawn

```typescript
// Used when building the continuation prompt for non-Claude runtimes
// or when Claude --resume fails
interface RecoveryContext {
  originalTask: string;
  branch: string;
  gitLog: string;       // Recent commit log on the branch
  uncommittedDiff: string; // git diff output (if any uncommitted changes)
}
```

## processSession() Recovery Contract

When `session.recoveryWorktreePath` is set:

1. **Worktree phase**: Skip `worktreeManager.create()`. Use
   `recoveryWorktreePath` as `worktreePath`. Derive `bareRepoPath` via
   `git rev-parse --git-common-dir`.

2. **Container phase**: Runs normally (kill old container if `containerId`
   still exists, spawn fresh).

3. **Agent phase**:
   - If `session.runtime === 'claude'` AND `session.claudeSessionId` exists:
     Use `runtime.resume(sessionId, continuationPrompt, containerId, env)`
   - Otherwise: Use `runtime.spawn()` with task = continuation prompt
     built from `RecoveryContext`

4. **Cleanup**: Set `recoveryWorktreePath = null` after container is running.
