# Brief: Local Session Reconciler

## Objective
Replace the destructive orphan-kill logic in `index.ts` with a local
reconciler that recovers sessions instead of killing them. Mirrors the
ACI reconciler pattern.

## Dependencies
- Brief 01 (DB + types) — needs `recoveryWorktreePath` field

## Blocked By
Brief 01.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/sessions/local-reconciler.ts` | create | New reconciler module |
| `packages/daemon/src/index.ts` | modify | Replace orphan-kill block (lines 349-385) with local reconciler call |

## Implementation Notes

### Reconciler Logic (local-reconciler.ts)

Mirror the structure of `reconciler.ts` (ACI reconciler):

```typescript
export async function reconcileLocalSessions(deps): Promise<ReconcileResult> {
  const result = { recovered: [], killed: [], skipped: [] };

  // Find all non-terminal local sessions
  const orphanStatuses = [
    'running', 'provisioning', 'queued', 'awaiting_input',
    'validating', 'paused', 'killing',
  ];

  for (const status of orphanStatuses) {
    const sessions = deps.sessionRepo.list({ status });
    const localSessions = sessions.filter(s => s.executionTarget === 'local');

    for (const session of localSessions) {
      await reconcileSession(session, deps, result);
    }
  }

  return result;
}
```

### Per-session reconciliation:

1. **Sessions already in `killing`** → finish the kill (current behavior):
   ```typescript
   sessionRepo.update(id, { status: 'killed', completedAt: now });
   ```

2. **Sessions in `queued`** → leave alone, they'll be processed normally.
   Add to `skipped`.

3. **Sessions with `worktreePath` that still exists on disk**:
   - Kill old container if `containerId` exists (best-effort, may already be gone)
   - Transition to `queued` via: `running → killing` then set status directly
     to `queued` (bypass state machine for recovery — document why)
   - Set `recoveryWorktreePath = session.worktreePath`
   - Clear `containerId` (will get a new one)
   - Re-enqueue via `enqueueSession(session.id)`
   - Add to `recovered`

4. **Sessions whose worktree is gone** → kill (current behavior).
   Use the same `markSessionFailed()` pattern from ACI reconciler.

### State machine bypass

Recovery requires `running → queued` which isn't a valid transition. Options:
- Add it to the state machine (pollutes the normal flow)
- Bypass with direct `sessionRepo.update()` (pragmatic, well-documented)

**Go with direct update** — this is a crash recovery path, not normal flow.
Add a clear comment explaining why. Emit a `session.status_changed` event
so the TUI/dashboard updates.

### index.ts changes

Replace the orphan-kill block with:

```typescript
// Reconcile local sessions (non-blocking — errors logged, not fatal)
{
  const { reconcileLocalSessions } = await import('./sessions/local-reconciler.js');
  reconcileLocalSessions({
    sessionRepo,
    eventBus,
    dockerContainerManager,
    enqueueSession: (id) => sessionQueue.enqueue(id),
    logger,
  }).then((result) => {
    if (result.recovered.length > 0) {
      logger.info({ recovered: result.recovered }, 'Local sessions recovered');
    }
    if (result.killed.length > 0) {
      logger.warn({ killed: result.killed }, 'Unrecoverable local sessions killed');
    }
  }).catch((err) => {
    logger.error({ err }, 'Local session reconciliation failed');
  });
}
```

### Worktree existence check

Use `fs.access(session.worktreePath)` — simple, fast, no git operations needed.

### Kill old container (best-effort)

```typescript
if (session.containerId) {
  try {
    await dockerContainerManager.kill(session.containerId);
  } catch {
    // Container may already be gone — that's fine
  }
}
```

## Acceptance Criteria

- [ ] Daemon starts without killing recoverable local sessions
- [ ] Sessions with surviving worktrees are re-queued (status → queued)
- [ ] Sessions with missing worktrees are killed (current behavior preserved)
- [ ] Sessions in `killing` state are finished to `killed`
- [ ] Old containers are cleaned up (best-effort)
- [ ] `recoveryWorktreePath` is set on re-queued sessions
- [ ] Events emitted for status changes (TUI stays in sync)
- [ ] Recovery is non-blocking — daemon starts regardless of reconciliation outcome
- [ ] Log output clearly indicates which sessions were recovered vs killed

## Estimated Scope
Files: 2 | Complexity: medium
