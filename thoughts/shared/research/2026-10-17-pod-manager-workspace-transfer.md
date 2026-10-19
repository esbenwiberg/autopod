---
date: 2026-10-17T20:12:24+0200
researcher: Codex
git_commit: 944f5c46cece345dbf3786bd8ca4c57ebf6fe326
branch: codex/pod-manager-workspace
repository: autopod
topic: "Workspace transfer and recovery after the preservation extraction"
tags: [research, codebase, pod-manager, workspace-transfer]
status: complete
last_updated: 2026-10-17
last_updated_by: Codex
---

# Research: workspace transfer and recovery

## Research question

Continue the incremental pod-manager rewrite after completing the first approved
workspace-preservation extraction. Locate the remaining transfer implementation,
its shared dependencies, callers and existing verification.

## Summary

The preservation factory now delegates local work to syncWorkspaceBack. That
callback still lives inside pod-manager, together with Docker mirror scripts,
archive fallback, Git recovery and engine retry handling. Other callers use these
operations directly. Validation, provisioning and approval also use some of the
same helpers, so their dependencies extend beyond preservation.

All references below are relative to packages/daemon/src/ at commit 944f5c46.

## Detailed findings

### Transfer and fallback

- pods/pod-manager.ts:5639 wraps syncWorkspaceBackOnce in withEngineStallRetry.
  Its default executionTarget is local and its result is { pushed: boolean }.
- :6124 uses archive extraction immediately for executionTarget sandbox. For other
  targets it reads container alternates, compares against a host-derived Git
  common directory, and only pushes when the paths match. Derivation failure or
  mismatch skips the push while retaining file synchronization.
- :6187 uses worktrees/bare-push.ts:65 to publish through a per-pod staging ref.
  A false push result is logged and retained as evidence for callers' deletion
  guard; it does not itself fail file synchronization.
- :6236 builds a shell script that stages source files inside the bind mount,
  checks entry counts, overlays the staged files and deletes absent host paths.
  It excludes .git and runtime caches, preserving the host gitlink. Staging is
  cleaned by a shell trap. Any exception in this path, including index refresh,
  invokes archive fallback. Copy-first staging is not an atomic host-tree swap.
- :6289 extracts /workspace with exclusions. It then attempts separate .git
  extraction into os.tmpdir()/autopod-git-${Date.now()}, a host-side staging-ref
  push and finally temporary-directory removal. Workspace extraction failure
  propagates. Git recovery is best effort; success refreshes the host index and
  index-refresh failure propagates.

### Retry and live recovery

- :5522 classifies Error messages containing the existing engine/socket error
  substrings; non-Error values do not qualify.
- :5547 polls status every 2,000 ms. Running returns ready, stopped/deleted returns
  gone, unknown/errors continue until timeout. The helper also serves validation
  at :14873 with a 30,000 ms budget.
- :5582 permits three operation attempts, with reachability budgets of 5,000 and
  15,000 ms before retries. These are maximum polling budgets, not mandatory sleeps.
  Ready or timeout permits another attempt; gone rethrows the preceding error.
  Classification occurs after the inner operation's archive fallback.
- :6364 only recovers from a running container. It checks alternates before a
  possible push, extracts files, refreshes the host index and returns true. A false
  push result does not by itself prevent success. Any thrown exception returns false.
- :6609, :12264 and :18848 consume the recovery result in separate orchestration
  paths. The public recoverWorktree operation owns commits, compromised flags and
  restore-from-HEAD fallback. Those decisions are outside the transfer helper.

### Shared helpers and callers

- :619 shellQuote is also used by provider/provisioning scripts.
- :623 runtime cache exclusions are shared with provisioning. :624 adds .git for
  sync-back; :629 uses that broader list in approval snapshot exclusions.
- :657, :662 and :666 build mirror expressions and shell copies. Provisioning at
  :9501 uses the cache-only exclusions so that its initial copy includes .git.
- :1104 derives the bare path with git rev-parse --git-common-dir and path.resolve.
  Besides transfer/recovery, callers at :5884 and :8905 use this helper for
  validation reconciliation and provisioning.
- Direct sync callers occur at :3000, :6062, :6071, :6098, :8625, :12149, :14249,
  :14455, :15129 and :18452. Preservation receives the callback at :5654.
- Validation HEAD comparison/divergence handling, completion admission, lifecycle,
  cleanup and repository decisions remain manager-owned after the first extraction.

### Existing tests and evidence limits

- pods/pod-manager.test.ts:14862 and :21171 cover recovery before validation and
  before auto-commit. :21214 checks generated sync script cache exclusions;
  :21252 covers verified sandbox checkpoint routing; :21340 checks host index
  refresh after promotion; :21426 covers failed sync stopping completion.
- worktrees/bare-push.test.ts uses actual private local repositories to cover
  checked-out branch protection, staging promotion, non-fast-forward refusal,
  detached HEAD and first branch creation. The algorithm is independently tested.
- pods/workspace-preservation.test.ts and the 17 public preservation compatibility
  cases cover the completed first extraction. Their successful verification is
  recorded in the prior plan, not evidence of a future transfer extraction.
- Existing script-string assertions do not execute the mirror against a real host
  directory. Existing mocked container tests do not establish live Docker behavior.

## Architecture documentation

The manager currently composes preservation with a transfer callback while
retaining all transfer implementations in its closure. ContainerManager provides
exec, status and archive operations. Git staging publication already has a
separate worktrees module. Public lifecycle methods interpret transport results.

## Historical context

The completed 2026-10-17 preservation plan explicitly deferred Docker transport,
validation reconciliation and recovery-status policy. Commit 944f5c46 implements
that approved boundary. No new product source was edited during this research.

## Related research

- 2026-10-17-pod-manager-workspace-preservation.md

## Open questions

None concerning the mapped current behavior. Live Docker/Azure qualification has
not been performed and is outside this local codebase research.
