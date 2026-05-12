---
title: "Push agent commits to bare every 60s for durable recovery"
touches:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/system-instructions-generator.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/pods/system-instructions-generator.test.ts
does_not_touch:
  - packages/daemon/src/pods/local-reconciler.ts
  - packages/daemon/src/worktrees/
  - packages/shared/src/types/
---

## Task

Extend the existing commit-poller in `pod-manager.ts` so that every 60s, in
addition to refreshing `commitCount` and `lastCommitAt`, it executes
`git push <bareRepoPath> HEAD` inside the agent's container. Also enhance
the "Commit your work" block in `system-instructions-generator.ts` so the
agent understands why frequent commits matter for durability.

No auto-commits. The daemon only replicates work the agent has actually
committed. The push is silent (next-tick retry on failure) and runs for
every pod in `running` state.

## Why

Today, agent commits live only inside the container's `/workspace/.git`
until a sync trigger fires (handoff, end-of-pod, before/after validation).
A daemon crash, laptop reboot, or container death between sync triggers
loses every commit the agent has made since the last trigger. The
`local-reconciler` then kills the old container without first extracting
state, compounding the loss.

This is Layer 1 of a two-layer recovery design discussed with the operator.
Layer 1 covers committed work (cheap, ~80 LOC, no workflow change). Layer
2 (snapshot ref for uncommitted state, sync-back refactor, reconciler
pre-kill snapshot fetch) is a separate future pod and is explicitly out of
scope here.

## Touches

- `packages/daemon/src/pods/pod-manager.ts` — extend the `poll()` body
  inside `startCommitPolling()` (currently `~line 1589-1617`) to run
  `cm.execInContainer(containerId, ['git', '-C', '/workspace', 'push',
  bareRepoPath, 'HEAD'], { timeout })` after the existing count/log step.
  Resolve `bareRepoPath` via `deriveBareRepoPath(pod.worktreePath)`
  (defined at `~line 380`), never from container-supplied alternates.
- `packages/daemon/src/pods/system-instructions-generator.ts` — extend
  the existing "Commit your work — properly" block at `~line 503-522` with
  a short durability rationale (see Constraints).
- `packages/daemon/src/pods/pod-manager.test.ts` — new tests for the
  push step (see Test expectations).
- `packages/daemon/src/pods/system-instructions-generator.test.ts` —
  assertion that the durability rationale text appears in the rendered
  instructions.

## Does not touch

- `packages/daemon/src/pods/local-reconciler.ts` — Layer 2 territory.
  Layer 1 is push-only; recovery-time behavior is unchanged.
- `packages/daemon/src/pods/pod-manager.ts` lines `~1858-2000`
  (`syncWorkspaceBack` + helpers) — leave the existing in-container
  push and file-copy logic untouched. Layer 1 is purely additive.
- `packages/daemon/src/worktrees/` — host-side worktree operations are
  not in scope.
- `packages/shared/src/types/` — no new types, no new fields, no
  schema change.

## Constraints

- **Use the daemon-derived bare path, not container-supplied alternates.**
  `syncWorkspaceBack` at `pod-manager.ts:1898-1909` already enforces this
  pattern: an adversarial agent could rewrite
  `/workspace/.git/objects/info/alternates` to point at a different remote.
  The new push must call `deriveBareRepoPath(pod.worktreePath)` and use
  that path directly. If derivation throws, skip the tick's push.
- **Do not wrap the push in `withEngineStallRetry`.** That helper exists
  for one-shot sync-back where leaving the host worktree partially synced
  is catastrophic. The periodic push is *idempotent and self-healing* —
  if a tick fails (engine stall, lock contention, transient exec error),
  the next tick at +60s retries automatically. Wrapping it just delays the
  next agent push during outage windows.
- **Silently swallow failures.** Match the existing poller pattern at
  `pod-manager.ts:1613-1616`: log at `debug` level, no event emission, no
  pod status change, no activity-status message. Per the operator's
  decision: visibility into chronic push breakage is a Layer 2 concern.
- **Refspec is `HEAD` only.** Mirrors the existing in-container push at
  `pod-manager.ts:1911-1914`. Don't push refs/heads/* or refs/tags/* —
  the agent's working branch is the only thing that matters for recovery.
- **Skip the push if `pod.worktreePath` is null or `pod.containerId` is
  null.** The existing poller already gates on `pod.status === 'running'`
  (line 1592); the new push step adds these two preconditions as additional
  guards.
- **Lock contention with the agent's own commits is expected and benign.**
  Git uses `.lock` files in `.git/`; if the agent is mid-commit when the
  poller fires, one of the two ops will fail. The poller's failure is
  swallowed; next tick succeeds.

## Skills to reference

None. The detection table in `/prep` (profile fields, pod states) doesn't
match this work. The brief is small enough that the agent can execute it
directly from the constraints above.

## Test expectations

### `pod-manager.test.ts`

Add a new `describe('commit-poller bare push', ...)` block. Use the same
mock infrastructure (`createTestDb()`, mocked `ContainerManager`) the file
already establishes. Each test should drive a single poller tick directly
rather than relying on `setInterval` timing — extract the tick function or
expose it for testing via a manual trigger.

Behaviours to cover:

1. **Happy path** — when a pod is `running` with a containerId and a
   worktreePath, one poller tick invokes `cm.execInContainer` with
   `['git', '-C', '/workspace', 'push', <bareRepoPath>, 'HEAD']`. Assert
   the exact argv.
2. **Bare path source** — the `bareRepoPath` argument is the value
   returned by `deriveBareRepoPath(pod.worktreePath)`. Spy on
   `deriveBareRepoPath` (or mock the host filesystem so the real function
   returns a known value) and assert the push call carries that exact
   path.
3. **Push failure is swallowed** — `cm.execInContainer` rejects (or
   returns non-zero exit code) → tick completes without throwing, no
   event is emitted on the eventBus, pod status is unchanged, the next
   tick still fires.
4. **Skipped when pod is not running** — pod with `status='paused'` /
   `awaiting_input` / `validating`: tick does not call the push exec.
   (The existing `status !== 'running'` guard at line 1592 covers this;
   regression-protect it.)
5. **Skipped when worktreePath is null** — pod is `running` but
   `worktreePath` is null: tick does not call the push exec, no throw.
6. **Skipped when containerId is null** — pod is `running` but
   `containerId` is null: tick does not call the push exec, no throw.
7. **Skipped when `deriveBareRepoPath` throws** — derivation failure
   does not crash the tick or emit events; the count/log step still runs.

### `system-instructions-generator.test.ts`

Add one test (or one assertion in the existing "Commit your work" test)
that the rendered instructions for a non-workspace pod contain the
durability rationale — e.g. a substring like `"every 60s"` or
`"safe location"` or whatever phrasing lands in the source. Keep the
assertion targeted enough that minor copy edits don't break it but
specific enough that accidentally deleting the rationale block does.

## Risks / pitfalls

- **First tick race**: the poller calls `captureStartSha()` then immediate
  `poll()` (line 1619). If the new push step runs before the gitlink
  conversion (`pod-manager.ts:3563`) has completed in early provisioning,
  `/workspace/.git` may not yet be wired with the bare alternate. The
  existing `pod.status === 'running'` guard should already prevent this
  (status only becomes `running` after provisioning), but the push should
  be tolerant — a `git push` against an unwired repo will fail, which the
  silent-swallow path handles cleanly.
- **Disk pressure**: `git push` to bare creates pack files on the host
  filesystem. Most pushes are fast-forwards (no new objects). The
  marginal cost per 60s tick is dominated by `git rev-parse` and the
  refs update, not object writes. Not expected to be a problem in
  practice; flag if measured.
- **Concurrent pods on the same bare**: not currently possible — each
  pod gets its own worktree off a per-pod bare. Documented for future
  multi-pod-per-repo scenarios.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
