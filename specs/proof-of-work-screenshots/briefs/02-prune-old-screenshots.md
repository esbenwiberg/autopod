---
title: "Sweep terminal-pod screenshots past retention"
depends_on: [01-add-screenshot-store]
acceptance_criteria:
  - { type: cmd, test: "test -f packages/daemon/src/pods/screenshot-retention.ts", pass: "exit 0", fail: "the retention sweeper module is missing" }
  - { type: cmd, test: "grep -nE 'AUTOPOD_SCREENSHOT_RETENTION_DAYS' packages/daemon/src/index.ts", pass: "exit 0 — the env var is read on boot", fail: "the daemon doesn't honour the retention env var" }
  - { type: cmd, test: "grep -nE 'screenshotRetention|ScreenshotRetention' packages/daemon/src/index.ts", pass: "exit 0 — the sweeper is wired into the boot path", fail: "the sweeper isn't started on boot" }
touches:
  - packages/daemon/src/pods/screenshot-retention.ts
  - packages/daemon/src/pods/screenshot-retention.test.ts
  - packages/daemon/src/index.ts
does_not_touch:
  - packages/daemon/src/pods/screenshot-store.ts
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/api/routes/
  - packages/daemon/src/worktrees/
  - packages/desktop/
---

## Task

Add a retention sweeper that periodically deletes screenshot
directories for pods in terminal states (`complete`, `killed`,
`failed`) past the configured retention period. Default: 30 days.
Configurable via `AUTOPOD_SCREENSHOT_RETENTION_DAYS`.

This is a daemon-side cleanup loop, not a state-machine event hook.
It runs on a periodic timer to keep the implementation simple and
avoid coupling the pod-manager state transitions to filesystem
operations. A pod that flips to `complete` does NOT trigger an
immediate sweep — the next periodic tick handles it.

### `ScreenshotRetention` module

Create `packages/daemon/src/pods/screenshot-retention.ts` exporting:

```ts
export interface ScreenshotRetentionOptions {
  retentionDays: number;
  sweepIntervalMs: number;
  podRepository: PodRepository;
  screenshotStore: ScreenshotStore;
  logger: Logger;
}

export class ScreenshotRetention {
  start(): void;       // begin periodic sweep
  stop(): void;        // clear timer; idempotent
  sweepOnce(): Promise<{ scanned: number; deleted: number }>;
}
```

`start()` runs `sweepOnce()` immediately, then every
`sweepIntervalMs`. `stop()` clears the timer. The class holds a
reference to the in-flight sweep so `stop()` can wait for it (or at
least not double-fire).

`sweepOnce` algorithm:

1. Query the pod repository for pods in terminal states
   (`complete | killed | failed`) whose `completed_at` (or
   equivalent terminal timestamp) is older than `now -
   retentionDays`. Reuse whatever timestamp `pod-repository.ts`
   already exposes; do NOT add a new column.
2. For each such pod, call `screenshotStore.delete(pod.id)`. The
   store's `delete` is idempotent — pods that never had screenshots
   (workspace pods, pre-cutover pods) are no-ops.
3. Aggregate counts and return `{ scanned, deleted }`. Log one
   summary line per sweep at `info` level. Per-pod deletes log at
   `debug`.

A failed delete (e.g. permission error, mid-flight read holding the
file open on Windows — autopod is *nix-only but defence in depth)
must NOT abort the sweep. Log the error and continue to the next
pod.

### Configuration

In `packages/daemon/src/index.ts`:

```ts
const retentionDays = Number.parseInt(
  process.env.AUTOPOD_SCREENSHOT_RETENTION_DAYS ?? '30',
  10,
);
if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
  throw new Error(
    'AUTOPOD_SCREENSHOT_RETENTION_DAYS must be a positive integer',
  );
}
const screenshotRetention = new ScreenshotRetention({
  retentionDays,
  sweepIntervalMs: 60 * 60 * 1000, // 1 hour
  podRepository,
  screenshotStore,
  logger: rootLogger.child({ component: 'screenshot-retention' }),
});
screenshotRetention.start();
```

Wire the `stop()` call into the existing graceful-shutdown handler
(SIGTERM / SIGINT) alongside the daemon's other periodic workers.

`sweepIntervalMs` is hard-coded at 1 hour for now — exposing it via
env var is a YAGNI. Retention period is the only dial users touch.

### `screenshot-retention.test.ts`

Use `createTestDb()` and a mock `ScreenshotStore` (or an
in-memory test double). Test cases:

- **Empty cohort.** No terminal pods. `sweepOnce` returns
  `{ scanned: 0, deleted: 0 }`; the store's `delete` is never
  called.
- **Fresh terminal pod.** A pod completed 5 days ago with
  `retentionDays: 30`. NOT swept. `delete` not called.
- **Stale terminal pod.** A pod completed 31 days ago. Swept.
  `delete(podId)` called once.
- **Mixed cohort.** Three pods: one fresh, one stale, one
  non-terminal-but-old. Only the stale one is swept.
- **Idempotency.** Run `sweepOnce` twice in a row against the same
  stale pod. The store's `delete` is called twice (it's idempotent
  on the store side — that's the store's contract, not the
  sweeper's). Confirm the sweeper doesn't track per-pod state to
  avoid re-deleting; the store handles it.
- **Delete failure isolation.** Three stale pods; the store's
  `delete` throws for the second one. Sweep continues; pods 1 and
  3 are deleted; an error is logged for pod 2; the returned
  `deleted` count is 2.
- **Retention day boundary.** Pod completed exactly
  `retentionDays * 24 * 60 * 60 * 1000` ms ago: SWEEP it (use `<=`
  on the boundary, not `<`). Document the choice in a comment in
  the source — boundary-inclusive saves debate.
- **Workspace pods.** Workspace pods never have screenshots, but
  they hit terminal states. Confirm the sweeper still calls
  `delete` for them and the store no-ops (no error).

### Boundaries

This brief does not need to know what brief 02-api or 02-ado are
doing. The pod repository query, the store interface, and the env
var are the only seams.

## Touches

- `packages/daemon/src/pods/screenshot-retention.ts` *(new)* — the
  sweeper.
- `packages/daemon/src/pods/screenshot-retention.test.ts` *(new)* —
  unit tests via `createTestDb` + store double.
- `packages/daemon/src/index.ts` — env var read, instantiation,
  wiring into start/stop.

## Does not touch

- `packages/daemon/src/pods/screenshot-store.ts` — brief 01 owns
  the store contract.
- `packages/daemon/src/db/migrations/` — no schema change.
- `packages/daemon/src/api/routes/` — brief 02-api.
- `packages/daemon/src/worktrees/` — brief 02-ado.
- `packages/daemon/src/pods/pod-manager.ts` — the sweeper does NOT
  hook into pod-manager state transitions. Periodic timer only.
- `packages/desktop/` — brief 03.

## Constraints

From `design.md` → Seams: "Pod terminal-state event ↔ retention
sweep" — sweeper polls pods in terminal states and calls
`ScreenshotStore.delete(podId)`. Polling, not event-driven.

From `purpose.md` → Glossary: "Retention period — days a terminal
pod's screenshots persist on disk before the sweeper deletes
them. Default 30, configurable via env var
`AUTOPOD_SCREENSHOT_RETENTION_DAYS`." Frozen.

From `purpose.md` → Glossary: "Terminal state — `complete`,
`killed`, or `failed`". Use `isTerminalState` from
`packages/daemon/src/pods/state-machine.ts` if it's exported, or
mirror the same set inline. Don't redefine the set.

From `daemon/CLAUDE.md` → "Common Gotchas": background workers
must be stopped in cleanup paths. The sweeper's `stop()` must be
called on graceful shutdown alongside the existing intervals (the
60s commit-polling background worker is the precedent).

## Test expectations

See the cases enumerated in the module section above. The test
file uses `createTestDb()` to seed pods directly via the
repository, advances `Date.now()` (via `vi.useFakeTimers()` or by
inserting historic timestamps), and exercises `sweepOnce`
directly. The periodic-tick path can be smoke-tested with a small
`sweepIntervalMs` (e.g. 50ms) and `vi.advanceTimersByTime`.

Confirm `sweepOnce` does NOT throw when the store's `delete`
throws — it logs and moves on. This is the failure-isolation case
above.

Confirm `stop()` after `start()` cleanly cancels the next tick
(no further sweeps fire after stop).

Confirm `start()` is idempotent — calling it twice does not stack
two timers (or, if it does, document that it doesn't and it's the
caller's job to call once).

## Risks / pitfalls

- **What's the terminal-pod query?** `pod-repository.ts` has its
  own conventions. Skim it for an existing "list pods by status"
  helper. If one exists with the right shape, use it; otherwise
  add a single new query method (`listTerminalPodsCompletedBefore
  (cutoffIso: string): Promise<Pod[]>`). Don't open-code SQL in
  the sweeper.

- **`completed_at` semantics.** The phase-1 reliability brief
  flagged that `completed_at` may not be set on all terminal
  states. Verify — search `pod-repository.ts` for `completed_at =`
  writes. If `failed` pods don't get `completed_at` set, the
  sweeper either misses them or needs a fallback (use
  `created_at + maxRunDuration` or scan by file mtime). Document
  the choice; this is an interview the brief writer should
  resolve before coding.

- **Sweeping during an in-flight rework.** A pod may go
  `complete` then transition back to `provisioning` if a fix-pod
  spawns from a CI failure (per the lifecycle doc). If the
  retention sweep deletes screenshots while the pod is back in a
  non-terminal state, the desktop UI breaks. The cohort filter
  must include "current status is terminal" not just "completed_at
  is old". Read the current state from the repository at sweep
  time, not from a stale snapshot.

- **Filesystem safety.** `screenshotStore.delete(podId)` does
  `rm -rf <dataDir>/screenshots/<podId>`. The store (brief 01)
  must validate `podId` matches `^[a-z0-9]{8}$` (the
  `POD_ID_LENGTH=8` constant) before constructing the path, to
  rule out `..` injection. The sweeper trusts the store. If brief
  01's validation isn't in place, flag it — don't paper over by
  duplicating the check here.

- **Time source.** Use `Date.now()` consistently. The pod
  repository's timestamps are ISO strings — convert with
  `new Date(...).getTime()` in the cutoff comparison. Don't mix
  millisecond integers and ISO strings ad-hoc.

- **First-boot sweep blast.** On a daemon that's been running for
  months without retention, the first sweep on the first boot
  with this brief landed will delete a lot of directories. That's
  the point — but if the load is concerning, add a small per-pod
  sleep (e.g. 50ms) inside `sweepOnce`'s loop. Default to no
  sleep; only add if measured to be a problem.

## Wrap-up

1. Run `/simplify` and address findings.
2. `npx pnpm --filter @autopod/daemon test` — passes.
3. `npx pnpm build` — passes.
4. Manual smoke: set `AUTOPOD_SCREENSHOT_RETENTION_DAYS=0`, boot
   the daemon, confirm a freshly-completed pod has its
   `<dataDir>/screenshots/<podId>/` directory removed within an
   hour. (Or call `sweepOnce()` directly via a test hook.)
5. Manual smoke: confirm the daemon shuts down cleanly with
   SIGTERM (no hanging timer).
6. Commit and push.
