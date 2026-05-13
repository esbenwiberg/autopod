---
title: "Rewire fix-pod lifecycle: single canonical pod, queue-driven iterations, active merge re-attempt"
depends_on: [01-add-fix-queue-schema]
acceptance_criteria:
  - type: api
    outcome: "POST /pods/:parentId/spawn-fix {message:'M1'}; wait for fix-pod complete; POST /pods/:parentId/spawn-fix {message:'M2'}; GET /pods/:parentId — single fixPodId across both spawns, fixIteration goes 1→2, second iteration's task contains 'M2', parent stays in merge_pending"
    hint: "supertest the spawn-fix flow against a daemon with mocked Docker; assert the merge poller observed each iteration"
    polarity: pass-on-200
  - type: cmd
    outcome: "! grep -nE 'reuseFixPod|fixPodCooldownSec|DEFAULT_FIX_POD_COOLDOWN_MS' packages/daemon/src/pods/pod-manager.ts → exit 0 — deprecated branching gone"
    hint: "! grep -nE 'reuseFixPod|fixPodCooldownSec|DEFAULT_FIX_POD_COOLDOWN_MS' packages/daemon/src/pods/pod-manager.ts"
    polarity: exit-zero
  - type: cmd
    outcome: "grep -nE 'mergeQueue\\.enqueueMerge' packages/daemon/src/pods/pod-manager.ts → exit 0 in the merge-polling region (lines 1390-1545) — poller actively re-attempts merge"
    hint: "grep -nE 'mergeQueue\\.enqueueMerge' packages/daemon/src/pods/pod-manager.ts"
    polarity: exit-zero
touches:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/pods/state-machine.ts
  - packages/daemon/src/pods/pod-lifecycle.e2e.test.ts
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/fix-feedback-repository.ts
  - packages/daemon/src/api/routes/
  - packages/desktop/
---

## Task

Rewrite the fix-pod lifecycle in `pod-manager.ts` so that one canonical
fix pod per parent PR drains a feedback queue across all iterations,
completes after `git push`, and lets the parent's merge poller actively
re-attempt the merge. This is the heart of the spec.

### Wire up the repository

`PodManager` already takes its dependencies via constructor injection.
Add `fixFeedbackRepo: FixFeedbackRepository` to the constructor (built
in `daemon/src/index.ts` from the new module landed in brief 01) and
field on the class. Forward it through every call site that currently
constructs a `PodManager` in tests (`mock-helpers.ts` will need a small
factory).

### Rewrite `maybeSpawnFixSession`

Current signature (~`pod-manager.ts:1170`):

```ts
maybeSpawnFixSession(
  parentSessionId: string,
  status: PrMergeStatus,
  userMessage?: string,
  bypassCooldown = false,
)
```

New signature:

```ts
maybeSpawnFixSession(parentSessionId: string, status: PrMergeStatus)
```

`userMessage` and `bypassCooldown` go away — both concerns are absorbed
by the queue. Callers that used to pass `userMessage` (the
`spawnFixSession` API entrypoint) now enqueue via
`fixFeedbackRepo.enqueue` before calling this method (see brief 03).

New behaviour:

1. Look up the parent pod. If terminal (`isTerminalState(parent.status)`),
   return — caller's responsibility to surface `parent_terminal` (the API
   handles this in brief 03).
2. Look up `parent.fixPodId`. If non-null, fetch that pod.
3. If the fix pod exists and is non-terminal, **return**. Do not spawn.
   The caller has already enqueued whatever they wanted; the running
   iteration will recycle on completion and drain the queue then.
4. If no live fix pod, check the iteration cap: if `parent.fixIteration
   >= profile.maxPrFixAttempts` (default 5 after brief 01), transition
   the parent to `failed` with `failReason = 'fix-pod iteration cap
   exceeded'` and return.
5. Otherwise:
   - If `parent.fixPodId` is null OR the existing fix pod is terminal:
     create a NEW fix pod, set `parent.fixPodId = newPod.id`,
     `parent.fixIteration = (parent.fixIteration ?? 0) + 1`.
   - The fix pod is created in `queued` state via the existing path —
     do not skip queueing. Let `processPod` pick it up.

Delete the following from the current implementation:

- The `reuseFixPod` branching (1211–1218).
- The cooldown guard (1244–1258) and the
  `DEFAULT_FIX_POD_COOLDOWN_MS` constant at 1073.
- The long-lived fix pod re-enqueue branch (1275–1316) — its job
  is folded into step 5 above (every iteration is a fresh queueing of
  the same canonical fix-pod *identity*; whether we recycle the pod row
  or create a new one with the same `linkedPodId` is implementation
  choice — see "Recycle vs new pod row" below).

### Recycle vs new pod row

Two valid implementation choices:

(a) **Recycle the same `pods` row** via the legal `complete → queued`
   transition. The fix pod's history accumulates `fixIteration` values.

(b) **Create a fresh `pods` row per iteration**, all sharing the same
   `linkedPodId`. Old behaviour with `reuseFixPod: false`.

Choose (a). Reason: the existing `pod.fixIteration` counter only makes
sense if the same row is recycled; multiple rows would each carry
`fixIteration = 1`. The legal `complete → queued` transition is the
whole reason this design works.

Steps to recycle on completion:

1. Fix pod finishes `git push` (see "Fix pod finishes after push" below).
2. Transition `pushing → complete`.
3. The parent's merge poller observes the new HEAD on its next tick. If
   the PR now merges cleanly, parent transitions `merge_pending →
   merging → complete`.
4. If `hasActionableFailures()` fires again later (new SAST comments,
   new reviewer comments), the poller enqueues + calls
   `maybeSpawnFixSession`. Because `parent.fixPodId` still points at the
   completed fix pod, `maybeSpawnFixSession` notices it's terminal and
   transitions the existing row `complete → queued` via
   `podRepository.updateStatus()` (which calls `validateTransition`,
   already legal at `constants.ts:70`). `fixIteration` bumps.

### Drain the queue on iteration start

In `processPod` (the orchestration loop), when a fix pod transitions to
`running` (just after container spawn, before the runtime stream starts),
call:

```ts
const messages = this.fixFeedbackRepo.drain(parent.id);
const userMessage = messages.length
  ? messages.map(m => m.message).join('\n\n---\n\n')
  : undefined;
const task = buildPrFixTask(pod, status, podRepo, profile, userMessage);
```

`buildPrFixTask` already takes `userMessage` as its 5th parameter
(`pod-manager.ts:314`); reuse the existing signature. The double-dash
delimiter mirrors how `buildPrFixTask` already concatenates review
comments — keep the format consistent for the agent.

**Delete-after-running contract**: `drain` is called *after* the
transition to `running` has been committed. If the daemon crashes
between `provisioning` and `running`, the transaction inside `drain`
rolls back (or never runs at all) and the queue stays intact. The
next iteration drains the same messages plus anything new.

### Fix pod finishes after push

Today, fix pods go through the same `approveSession` path as parents
(`pod-manager.ts:5375-5614`). That path does pre-merge rebase, push, AND
`mergePr`.

For fix pods, replace the `approveSession` call with a push-only path:

1. Pre-merge rebase against base (reuse the rebase helper inside
   `approveSession` — extract if necessary to avoid duplication).
2. `git push` the feature branch.
3. Transition the fix pod `pushing → complete`. Stop. Do NOT call
   `prManager.mergePr`. Do NOT transition to `merging` / `merge_pending`.

The parent pod is in `merge_pending` and its poller takes over from
here.

### Active merge re-attempt in `startMergePolling`

Today `startMergePolling` (~`pod-manager.ts:1390–1545`) polls
`prManager.getPrStatus()` every 60 s and reacts to PR state, but does
not call `mergeQueue.enqueueMerge` on each tick — that only happened via
`approveSession`. Change the poller so that on every tick where
`status.mergeable === true && status.reviewDecision !==
'CHANGES_REQUESTED' && status.ciFailures.length === 0`, it calls
`mergeQueue.enqueueMerge(parent)`. The merge queue is keyed on
`(repoUrl, baseBranch)` and serialises attempts — concurrent ticks
don't pile up.

`hasActionableFailures()` (1471–1476) stays as-is for the
enqueue-then-spawn path. The new flow there is:

```ts
if (hasActionableFailures(status)) {
  const summary = comments.map(c => c.body).join('\n\n');
  this.fixFeedbackRepo.enqueue(parent.id, summary);
  await this.maybeSpawnFixSession(parent.id, status);
}
```

### State machine

`pod-lifecycle.e2e.test.ts` should already exercise `complete → queued`
for the legacy `reuseFixPod` path. Update / extend its tests for the new
flow but no `state-machine.ts` change is required — `VALID_STATUS_
TRANSITIONS` already includes `complete: ['queued']`. **Re-confirm** by
reading `packages/shared/src/constants.ts:36–76` while editing; if any
prior cleanup removed that entry, restore it.

### Tests

- `pod-manager.test.ts`: cover (a) first enqueue spawns a fix pod; (b)
  second enqueue while fix pod alive does NOT spawn another; (c)
  iteration completes → next enqueue recycles via `complete → queued`;
  (d) iteration cap exceeded → parent transitions to `failed`; (e)
  poller calls `mergeQueue.enqueueMerge` when status is mergeable.

- `pod-lifecycle.e2e.test.ts`: end-to-end multi-round scenario.
  Mocked container/runtime/network. Drive: parent → `merge_pending` →
  enqueue M1 → fix pod runs (task contains M1) → fix pod completes
  (push only, no merge call) → enqueue M2 → fix pod recycles
  (task contains M2) → poller succeeds → parent → `complete`.

## Test expectations

- All existing tests in `pod-manager.test.ts` and
  `pod-lifecycle.e2e.test.ts` stay green. Tests that asserted on the
  legacy `reuseFixPod: true` branching get rewritten; tests that
  asserted on the cooldown delete (since `fixPodCooldownSec` is gone).
- The mock-helpers `PodManager` factory grows a `fixFeedbackRepo`
  parameter; update every call site.
- Behavioural anchor: AC #1 (api) drives the canonical flow end-to-end.
  Regression to "spawn a new child fix pod per call" fails AC #1's
  `single fixPodId across both spawns` assertion.
- Regression to "fix pod calls `approveSession`" is caught by the e2e
  test, which asserts the parent's merge poller is the one calling
  `mergeQueue.enqueueMerge`, not the fix pod.
