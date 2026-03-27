# Local Session Recovery on Daemon Restart

## Problem

When the daemon process dies (laptop shutdown, crash, OOM), all local Docker
sessions are killed on restart. The orphan-kill logic in `index.ts:349-385`
transitions every non-terminal local session to `killed` and destroys the
worktree via `worktreeManager.cleanup()`.

This is unnecessarily destructive because:
- **Worktrees are bind-mounted** — all file changes (committed and uncommitted)
  survive on the host filesystem at `~/.autopod/worktrees/<branch>`
- **`claudeSessionId` is persisted** in SQLite — Claude CLI `--resume` can
  restore conversation context
- **Docker containers may still be alive** after a daemon crash (they run
  `sleep infinity` with `AutoRemove: false`)

## Goals

1. **Preserve work** — never destroy a worktree that has uncommitted or
   unpushed changes on daemon restart
2. **Resume Claude sessions** — use `--resume` with persisted `claudeSessionId`
   when possible, falling back to fresh spawn with continuation prompt
3. **Support all runtimes** — Claude gets `--resume`, Copilot/Codex get fresh
   spawn with context (they have no resume mechanism)
4. **Reuse existing infrastructure** — mirror the ACI reconciler pattern,
   re-queue through normal `processSession()` pipeline

## Approach: Re-queue with Recovery Flag

Rather than building a parallel `resumeSession()` code path that duplicates
the complex setup logic in `processSession()`, we:

1. **On startup**, replace orphan-kill with a local reconciler that:
   - Checks if the worktree still exists on disk
   - Checks Docker container status (running/stopped/unknown)
   - Transitions recoverable sessions to `queued` with a recovery flag
   - Only kills sessions whose worktree is gone (truly unrecoverable)

2. **In `processSession()`**, detect recovery mode and:
   - Skip worktree creation (reuse existing path from session record)
   - Derive `bareRepoPath` from existing worktree via `git rev-parse`
   - For Claude + valid `claudeSessionId`: use `runtime.resume()` instead of
     `runtime.spawn()` with a continuation prompt
   - For Copilot/Codex (or when `--resume` fails): fresh `runtime.spawn()` with
     a task that includes context about prior progress
   - Everything else (container spawn, skills, CLAUDE.md, credentials) runs
     normally through the existing pipeline

3. **Fallback chain**:
   - Worktree exists + container alive → reuse container + resume agent
   - Worktree exists + container dead → new container + resume agent
   - Worktree exists + resume fails → new container + fresh agent with context
   - Worktree gone → kill session (current behavior)

## Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `claudeSessionId` expired server-side | Resume fails, agent starts fresh | Catch resume errors, fall back to fresh spawn with continuation prompt |
| Worktree in dirty git state (mid-merge, rebase) | Agent confused by conflict markers | Auto-commit or stash uncommitted changes before recovery spawn |
| Container alive but in broken state | Agent hangs or errors | Kill old container, spawn fresh one (don't try to reuse broken containers) |
| `processSession()` transitions assume `queued` start | State machine rejects transition | Need `queued → provisioning` to work for recovered sessions (already does) |
| Profile config changed between crash and restart | Agent gets different config | Acceptable — recovery uses latest profile, same as a manual re-run |

## Dependency Graph

```
Brief 01 (DB + shared types)
    ↓
Brief 02 (local reconciler)
    ↓
Brief 03 (processSession recovery path)  ← depends on 01 + 02
    ↓
Brief 04 (tests)  ← depends on all above
```

## Alternatives Considered

### A: Dedicated `resumeSession()` method
Extract container setup into a reusable function called from both
`processSession()` and a new `resumeSession()`. Rejected because the setup
logic in `processSession()` is deeply interleaved with state transitions and
event emission — extracting it cleanly would be a large refactor with high
risk of regressions, and we'd have two code paths to maintain.

### B: New "recovering" state in state machine
Add a `recovering` status between `queued` and `provisioning`. Rejected because
it adds complexity to the state machine (new transitions, new UI states) for
no real benefit — the `queued` state already means "waiting to be processed",
which is exactly what a recovering session needs.
