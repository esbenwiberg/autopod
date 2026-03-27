# Validation Plan

## Unit Tests

Run the full test suite to catch regressions:
```bash
npx pnpm test
```

### Key test scenarios (see Brief 04 for details)
- Reconciler correctly categorizes sessions (recover/kill/skip)
- processSession recovery path skips worktree creation
- Claude `--resume` attempted with correct session ID
- Non-Claude runtimes get fresh spawn with recovery context
- Resume failure gracefully falls back to fresh spawn

## Integration Tests

### Startup recovery flow (can extend session-lifecycle.e2e.test.ts)

1. Create a session and advance it to `running`
2. Simulate daemon restart by directly calling the reconciler
3. Verify session transitions to `queued` with `recoveryWorktreePath` set
4. Process the re-queued session
5. Verify it completes successfully without creating a new worktree

## Build Validation

```bash
npx pnpm build   # All packages compile
npx pnpm lint     # Biome passes
npx pnpm test     # All tests pass
```

## Manual Verification (when Docker is available)

1. Start daemon, create a session, let it begin running
2. Kill the daemon process (`kill -9`)
3. Restart daemon
4. Observe logs for recovery messages (not kill messages)
5. Verify session continues and completes
6. Check that the worktree was reused (same path in logs)

## Edge Cases to Test

- [ ] Daemon restart with no orphaned sessions → clean startup, no errors
- [ ] Multiple orphaned sessions → all recovered independently
- [ ] Mix of local and ACI sessions → each uses its own reconciler
- [ ] Session whose profile was deleted → graceful failure (kill, don't crash)
- [ ] Corrupted worktree (exists but not a git repo) → kill, don't hang
- [ ] Container that takes long to kill → doesn't block reconciliation of others

## Rollback Plan

If recovery causes issues, the reconciler can be reverted to the kill-all
behavior by changing one line:
```typescript
// In local-reconciler.ts, change recoverable handling to:
markSessionFailed(session, deps);
```
