# ADR 001: Re-queue Recovery Instead of Dedicated Resume Path

## Context

On daemon restart, orphaned local sessions need to be recovered. Two approaches:
1. Build a `resumeSession()` method that replays container setup + resumes agent
2. Transition sessions back to `queued` with a recovery flag and let normal
   `processSession()` handle them

`processSession()` is ~250 lines of interleaved setup: worktree creation,
network config, skills resolution, CLAUDE.md generation, credentials injection,
registry config, and finally agent spawn. All of this needs to run on recovery
(except worktree creation).

## Decision

Re-queue with a `recoveryWorktreePath` field on the session. When
`processSession()` sees this field, it skips worktree creation and derives
`bareRepoPath` from the existing worktree. All other setup runs normally.

## Consequences

**Good:**
- Single code path for container setup — no duplication, no drift
- Recovery goes through the same queue, respecting concurrency limits
- Minimal new code (~50 lines in reconciler, ~20 lines conditional in processSession)

**Bad:**
- Recovery is not instant — session re-enters the queue and waits its turn
- `processSession()` gains a conditional branch (but it's small and isolated)

**Acceptable because:**
- Recovery after a crash is not latency-sensitive — the user just rebooted
- The conditional is at the top of processSession (worktree creation) and
  at the bottom (spawn vs resume), not scattered throughout
