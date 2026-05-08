---
title: "Wire wake-recovery into reconciler and processPod"
depends_on: [01-add-sleep-detector]
acceptance_criteria: []
touches:
  - packages/daemon/src/db/migrations/092_pod_last_recovery_trigger.sql
  - packages/shared/src/types/pod.ts
  - packages/daemon/src/pods/pod-repository.ts
  - packages/daemon/src/pods/local-reconciler.ts
  - packages/daemon/src/pods/local-reconciler.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
does_not_touch:
  - packages/daemon/src/runtimes/stream-grace.ts
  - packages/daemon/src/pods/sleep-detector.ts
---

## Task

Make the existing `reconcileLocalSessions()` accept a wake trigger and
have `pod-manager.ts` invoke it on `host.resumed` events. Plumb a
one-shot pod-row flag (`lastRecoveryTrigger`) so `processPod()` knows
*not* to penalise the pod (no `MAX_RECOVERIES` increment, no
`validationAttempts` increment) when the recovery was caused by host
sleep rather than daemon restart.

For non-Claude runtimes (codex, copilot) entering recovery via
`recoveryWorktreePath`, append a wake-correction postscript to the
resumed task prompt so the agent knows to look at git history before
redoing work.

### Scope, in detail

**1. Migration 092.**

```sql
-- packages/daemon/src/db/migrations/092_pod_last_recovery_trigger.sql
ALTER TABLE pods ADD COLUMN last_recovery_trigger TEXT;
```

Verify the highest existing prefix at implementation time
(`ls packages/daemon/src/db/migrations/ | tail -5`) — if a higher number
exists, bump. **Never reuse a number** (per CLAUDE.md → migration
numbering).

**2. `Pod` type addition (shared/src/types/pod.ts).**

```ts
lastRecoveryTrigger?: 'wake' | 'restart' | null;
```

**3. `pod-repository.ts`.**

Plumb `lastRecoveryTrigger` through `rowToPod`, INSERT, and UPDATE.
Camel-case in TS, snake-case in SQL.

**4. `local-reconciler.ts` — accept trigger.**

Extend `LocalReconcilerDependencies`:

```ts
export type ReconcileTrigger = 'restart' | 'wake';

export interface LocalReconcilerDependencies {
  // ... existing fields
  trigger?: ReconcileTrigger; // default 'restart'
}
```

In `recoverSession()` (`local-reconciler.ts:176`):

- When `trigger === 'wake'`:
  - Skip the `MAX_RECOVERIES` cap check entirely (`local-reconciler.ts:213`).
  - **Do not** increment `recoveryCount`.
- Stamp `lastRecoveryTrigger = trigger` on the pod row when re-enqueuing
  (in the `podRepo.update(...)` call that sets `recoveryWorktreePath`).
- Default `trigger` to `'restart'` so callers that don't pass it get
  current behaviour. The existing daemon-restart caller must still
  enforce the cap.

**5. `pod-manager.ts` — subscribe + processPod changes.**

5a. **Subscribe.** Where the stuck-pod watchdog is currently started
(near `pod-manager.ts:8271`), also subscribe to the event bus for
`host.resumed`. On receipt:

```ts
const result = await reconcileLocalSessions({
  podRepo,
  eventBus,
  containerManager: containerManagerFactory.get('local'),
  enqueueSession: (id) => this.enqueue(id),
  validationRepo,
  logger,
  trigger: 'wake',
});
// re-publish a richer event so the desktop banner gets pod ids
eventBus.publish({
  type: 'host.resumed',
  timestamp: new Date().toISOString(),
  sleptMs: event.sleptMs,
  detector: event.detector,
  reconciledPodIds: result.recovered,
});
```

The detector publishes the *initial* event (with `reconciledPodIds: []`)
in brief 01. The pod-manager re-publishes the *completed* event with
the actual pod IDs after reconcile returns. The desktop subscribes to
`host.resumed` and uses the most recent payload — so it will momentarily
show "0 pods" then update to the real count, OR brief 04 buffers the
first event until the second arrives. Brief 04 picks the UX.

5b. **`validationAttempts` skip on wake recovery.** Around the
validation entry point in `processPod()` (`pod-manager.ts:6325`), read
`pod.lastRecoveryTrigger`:

```ts
let attempt: number;
if (pod.lastRecoveryTrigger === 'wake') {
  // Wake-recovery: don't burn an attempt for the involuntary restart.
  attempt = s1.validationAttempts; // hold steady; do NOT increment
  podRepo.update(podId, { lastRecoveryTrigger: null }); // one-shot
} else {
  attempt = (fromTerminal ? 0 : s1.validationAttempts) + 1;
  podRepo.update(podId, { validationAttempts: attempt });
}
```

The flag is consumed exactly once. Subsequent validation entries within
the same recovered run increment normally.

5c. **Wake-correction postscript for non-Claude runtimes.** In the
recovery branch where the resumed task prompt is built (find the path
that uses `recoveryWorktreePath` to spawn the runtime — around
`pod-manager.ts:3085`+), if the runtime is not `claude` AND
`pod.lastRecoveryTrigger === 'wake'`, append:

```
Note: this run was interrupted by a host sleep and restarted. Some
work may already be on disk — check `git log` and `git diff main`
before continuing.
```

For Claude, the conversation context comes from `--resume <session_id>`
and the postscript is unnecessary noise.

### Race condition (in-flight processPod)

When the wake handler calls `reconcileLocalSessions({ trigger: 'wake' })`,
some pods in `running` may already have an active `processPod()` loop
suspended on a dead `containerManager.exec()` or runtime stream. The
reconciler synchronously transitions the pod to `queued` *before*
calling `enqueueSession()`. Most `processPod()` await points are
followed by a status check before the next state transition; the
in-flight loop sees the changed state and returns cleanly.

**If the executor finds an await point with no state-check follow-up**
(particularly inside `consumeAgentEvents` or container-exec calls that
hold for minutes), introduce a per-pod `AbortController` mirroring
`validationAbortControllers` (`pod-manager.ts:1069`). On wake, abort
all in-flight controllers BEFORE calling the reconciler. The
`containerManager.exec()` and runtime APIs are already abort-aware in
some places — extend where needed.

This is a design concern that may or may not turn into code; let the
test failures (or a careful read of the in-flight flow) be the guide.
Don't add `AbortController` plumbing speculatively.

## Touches

- `packages/daemon/src/db/migrations/092_pod_last_recovery_trigger.sql`
  (new)
- `packages/shared/src/types/pod.ts` — add `lastRecoveryTrigger` field
- `packages/daemon/src/pods/pod-repository.ts` — plumb new column
- `packages/daemon/src/pods/local-reconciler.ts` — `trigger` param +
  cap exemption + flag stamp
- `packages/daemon/src/pods/local-reconciler.test.ts` — new tests
- `packages/daemon/src/pods/pod-manager.ts` — subscribe; validation
  skip; postscript
- `packages/daemon/src/pods/pod-manager.test.ts` — new tests

## Does not touch

- `packages/daemon/src/runtimes/stream-grace.ts` — wake-aware idle
  probe lives in brief 03.
- `packages/daemon/src/pods/sleep-detector.ts` — owned by brief 01.

## Constraints

- Migration prefix must be the next sequential number (092 is current
  expectation; verify before writing the file). **Never reuse a
  number** — silent application bug per CLAUDE.md.
- `lastRecoveryTrigger` is **one-shot**: cleared after first validation
  entry. Subsequent validation attempts inside the same recovered run
  increment normally.
- Daemon-restart behaviour MUST NOT regress: the existing
  `reconcileLocalSessions()` caller (in startup) does not pass
  `trigger`, so it defaults to `'restart'` and the existing cap
  enforcement runs unchanged.
- Wake-correction postscript only for non-Claude runtimes. Claude has
  full context via `--resume <session_id>`; do not add the postscript
  there (it would clutter the conversation).
- Re-publishing the completed `host.resumed` event with
  `reconciledPodIds` filled is the contract the desktop banner relies
  on (brief 04). Don't drop or rename this event.

## Test expectations

In `local-reconciler.test.ts`:

- `trigger: 'wake'` + pod with `recoveryCount = 5` → still recovers,
  cap not enforced, `recoveryCount` not incremented.
- `trigger: 'wake'` → pod row gets `lastRecoveryTrigger = 'wake'`
  before re-enqueue.
- `trigger: 'restart'` (default) → existing behaviour unchanged: cap
  enforced, `recoveryCount` incremented, `lastRecoveryTrigger` set to
  `'restart'`.
- Default trigger when omitted is `'restart'`.

In `pod-manager.test.ts`:

- A `host.resumed` event with `sleptMs > threshold` triggers a
  `reconcileLocalSessions` call with `trigger: 'wake'`.
- After reconcile completes, a second `host.resumed` event is
  published with `reconciledPodIds` populated.
- Validation entry on a pod with `lastRecoveryTrigger === 'wake'`:
  - does NOT increment `validationAttempts`
  - clears the flag (next read sees `null`)
- Validation entry on a pod with `lastRecoveryTrigger === 'restart'` or
  `null` increments normally.
- A non-Claude pod recovering with `lastRecoveryTrigger === 'wake'` has
  the wake-correction postscript appended to its resume task prompt.
- A Claude pod recovering with `lastRecoveryTrigger === 'wake'` does
  NOT have the postscript appended (assert via the resume-call mock).

Migration test:
- `createTestDb()` succeeds with migration 092 applied.
- `pods.last_recovery_trigger` column exists and accepts NULL,
  `'wake'`, `'restart'`.

## Risks / pitfalls

- `pod-manager.ts` is ~8500 lines; landing this brief in parallel with
  brief 03 risks merge conflicts. Sequence 03 *after* 02.
- The validation entry path has multiple branches (`fromTerminal`,
  rework, etc.) — make sure the wake skip only applies to the *first*
  validation entry post-recovery and doesn't interact with rework
  semantics. Check `pod-manager.ts:6321` (the existing
  `validationAttempts: 0` reset) for context.
- The existing reconciler at `local-reconciler.ts:186` has a fast-path
  for "validation already passed + PR exists" that skips re-validation.
  Wake-recovery should hit this fast-path the same way as restart
  recovery — don't break it.
- When stamping `lastRecoveryTrigger`, do it in the same `podRepo.update()`
  call that sets `recoveryWorktreePath` so the two writes are atomic.
- Don't forget to update `Pod` type assertions in mock helpers
  (`packages/daemon/src/test-utils/mock-helpers.ts`) if any test fixture
  needs the new field.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
