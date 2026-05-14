---
title: "Single fix pod: queue-driven lifecycle + spawn-fix API (supersedes briefs 02 + 03)"
depends_on: [01-add-fix-queue-schema]
supersedes: [02-rewire-fix-pod-lifecycle, 03-update-spawn-fix-api]
acceptance_criteria:
  - type: api
    outcome: "POST /pods/:parentId/spawn-fix {message:'a'} three times while a fix pod is running — all return 202, final body matches {ok:true, queued:true, queueLength:3, fixPodId:'<same>'}; DB has 3 rows in pending_fix_feedback for the parent"
    hint: "supertest the route against a Fastify app built with createTestDb() + a mocked PodManager; mock the fix pod as 'running'"
    polarity: pass-on-200
  - type: api
    outcome: "POST /pods/:parentId/spawn-fix against a terminal parent (status 'complete') → 409 {ok:false, reason:'parent_terminal'}; missing body or empty message → 400"
    hint: "app.inject the route with payload variants"
    polarity: pass-on-200
  - type: cmd
    outcome: "! grep -nE 'reuseFixPod|fixPodCooldownSec|DEFAULT_FIX_POD_COOLDOWN_MS' packages/daemon/src/pods/pod-manager.ts → exit 0 — deprecated branching gone"
    hint: "! grep -nE 'reuseFixPod|fixPodCooldownSec|DEFAULT_FIX_POD_COOLDOWN_MS' packages/daemon/src/pods/pod-manager.ts"
    polarity: exit-zero
  - type: cmd
    outcome: "grep -nE 'mergeQueue\\.enqueueMerge' packages/daemon/src/pods/pod-manager.ts → exit 0 — the merge poller actively re-attempts the merge"
    hint: "grep -nE 'mergeQueue\\.enqueueMerge' packages/daemon/src/pods/pod-manager.ts"
    polarity: exit-zero
  - type: cmd
    outcome: "npx pnpm --filter @autopod/daemon test → exit 0 — all daemon tests green including the new fix-queue coverage"
    hint: "npx pnpm --filter @autopod/daemon test"
    polarity: exit-zero
touches:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/worktrees/merge-queue.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/index.ts
  - packages/daemon/src/test-utils/mock-helpers.ts
  - packages/daemon/src/pods/pod-lifecycle.e2e.test.ts
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/fix-feedback-repository.ts
  - packages/shared/
  - packages/desktop/
---

## Why this brief exists

Briefs 01, 04, 05 of the `single-fix-pod` series shipped in PR #121. Briefs 02
(lifecycle rewire) and 03 (spawn-fix API) never produced code — the series PR
merged without them. The result: `FixFeedbackRepository` and the
`pending_fix_feedback` table exist but nothing reads or writes them; the desktop
`FixQueuePopover` is wired to a queue that is never populated; `POST
/pods/:podId/spawn-fix` still runs the legacy silent-no-op path.

This brief combines 02 + 03 into one pod because the API rewrite is meaningless
without the consumer-side lifecycle change — they share the `maybeSpawnFixSession`
seam and must ship together.

It also corrects two errors carried by the original briefs, both verified against
the current code:

- `mergeQueue.enqueueMerge` did not exist — `MergeQueue` only had `run` + `keyFor`.
  This brief adds `enqueueMerge` as a thin wrapper.
- `validated → complete` is not a legal transition. Fix pods reach `complete`
  via the existing legal path `validated → approved → merging → merge_pending →
  complete`, doing rebase+push (no `mergePr`) inside the `merging` step.

## Task

### 1. `MergeQueue.enqueueMerge` (`worktrees/merge-queue.ts`)

Add a thin convenience method so the merge poller has a single, greppable call:

```ts
enqueueMerge<T>(
  repoUrl: string | null | undefined,
  baseBranch: string,
  fn: () => Promise<T>,
): Promise<T> {
  return this.run(MergeQueue.keyFor(repoUrl, baseBranch), fn);
}
```

No behaviour change — `run` already serialises by `keyFor`. This is purely the
named seam the lifecycle code (and AC #4) expects.

### 2. Wire `FixFeedbackRepository` into `PodManager`

- `PodManagerDependencies` (`pod-manager.ts:569`) gains
  `fixFeedbackRepo: FixFeedbackRepository`.
- Destructure it in `createPodManager` (`pod-manager.ts:834`).
- `index.ts`: build it via `createFixFeedbackRepository(db)` (the module landed
  in brief 01) and pass it into `createPodManager({ ... })` at `index.ts:532`.
- `test-utils/mock-helpers.ts`: the `PodManagerDependencies` object built around
  `mock-helpers.ts:448` gains `fixFeedbackRepo: createFixFeedbackRepository(db)`
  using the same in-memory `db` `createTestDb()` already owns.

### 3. Rewrite `maybeSpawnFixSession` (`pod-manager.ts:1236`)

Current signature:

```ts
maybeSpawnFixSession(parentSessionId, status, userMessage?, bypassCooldown = false)
```

New signature:

```ts
maybeSpawnFixSession(parentSessionId: string, status: PrMergeStatus)
```

`userMessage` and `bypassCooldown` are gone — both concerns are absorbed by the
queue. Callers enqueue via `fixFeedbackRepo.enqueue` *before* calling this.

New behaviour:

1. Re-read parent from DB. If `parent.linkedPodId` is set (fix pods never spawn
   sub-fixers) → return.
2. If `isTerminalState(parent.status)` → return (the API surfaces
   `parent_terminal`; the poller simply has nothing to do).
3. Look up `parent.fixPodId`. If it points at a **non-terminal** pod → return.
   The queue already holds the new message; the running iteration recycles on
   completion and drains it then.
4. If no live fix pod, check the iteration cap: if `parent.prFixAttempts >=
   (parent.maxPrFixAttempts ?? DEFAULT_MAX_PR_FIX_ATTEMPTS)` → transition the
   parent to `failed` with `mergeBlockReason = 'Max PR fix attempts (<n>)
   exhausted'`, `stopMergePolling`, return.
5. Otherwise spawn/recycle the canonical fix pod (recycle = choice (a), one
   `pods` row per parent PR):
   - If `parent.fixPodId` is null → create a fresh fix pod row (the existing
     `podRepo.insert` loop), `linkedPodId: parent.id`, branch/baseBranch/prUrl
     from `resolveBranchSource(parent)`, `fixIteration: 1`. Set
     `parent.fixPodId = newId`.
   - If `parent.fixPodId` points at a **terminal** pod → recycle it via the
     legal `complete → queued` (also `failed → queued`, `killed → queued`)
     transition: reset operational fields (containerId, worktreePath,
     validationAttempts, claudeSessionId, preSubmitReview, taskSummary,
     startedAt, completedAt, etc. — mirror the field list the old reuse path
     used at `pod-manager.ts:1343`), bump `fixIteration`.
   - Either way bump `parent.prFixAttempts`, set
     `parent.mergeBlockReason = 'Fix attempt <n>/<max> in progress'`, and
     `enqueueSession(fixPodId)`.
   - Do **not** build the task here. The task is built at drain time (step 4
     below) so it picks up every message queued between spawn and start.

Delete entirely: the `reuseFixPod` branch (~1255–1280, 1332–1378), the cooldown
guard (~1300–1319), and the `DEFAULT_FIX_POD_COOLDOWN_MS` constant
(`pod-manager.ts:1134`). `lastFixPodSpawnedAt` writes go away with the cooldown.

### 4. Drain the queue when a fix pod starts (`processPod`, `pod-manager.ts:3900`)

Immediately after the `transition(pod, 'running', { ... })` at line 3900, before
the agent stream starts, add a fix-pod branch keyed on `pod.linkedPodId`:

```ts
if (pod.linkedPodId) {
  const messages = fixFeedbackRepo.drain(pod.linkedPodId);
  if (messages.length > 0) {
    const userMessage = messages.map((m) => m.message).join('\n\n---\n\n');
    const profile = profileStore.get(pod.profileName);
    // The queue already carries CI/review content (the poller concatenated it
    // in at enqueue time), so a minimal status is sufficient — buildPrFixTask
    // folds `userMessage` into the task body.
    const minimalStatus: PrMergeStatus = {
      merged: false, open: true, blockReason: 'PR needs fixes',
      ciFailures: [], reviewComments: [],
    };
    const task = buildPrFixTask(pod, minimalStatus, podRepo, profile, userMessage);
    pod = podRepo.update(pod.id, { task });
  }
}
```

**Delete-after-running contract**: `drain` runs *after* the `running` transition
is committed. A daemon crash between `provisioning` and `running` leaves the
queue intact — `drain`'s SQLite transaction never ran. The next iteration drains
the same messages plus anything new.

### 5. Fix pod finishes after push — not via merge

Today a fix pod that passes validation reaches `validated` at
`pod-manager.ts:7099` (`const validatedPod = transition(s2, 'validated', { prUrl })`).
The branch was already pushed during the validation-pass block above it.
Currently it either sits at `validated` or auto-approves if `autoApprove` is set.

Add an explicit fix-pod completion branch right after line 7099, **before** the
`if (validatedPod.autoApprove)` check, keyed on `validatedPod.linkedPodId`:

```ts
if (validatedPod.linkedPodId) {
  await completeFixPodAfterPush(validatedPod);
  return;
}
```

`completeFixPodAfterPush(fixPod)` is a new helper in the closure:

1. Resolve `profile`, `baseBranch = fixPod.baseBranch ?? profile.defaultBranch ?? 'main'`.
2. Inside `mergeQueue.enqueueMerge(profile.repoUrl, baseBranch, async () => { ... })`:
   - `rebaseOntoBase({ worktreePath, baseBranch, pat: selectGitPat(profile) })`.
   - On conflict: update `mergeBlockReason` and skip the push (the agent already
     pushed pre-rebase; conflicts are surfaced on the parent's poller).
   - On success and not `alreadyUpToDate`: `pushBranch(worktreePath, branch, { force: true })`.
3. `transition(fixPod, 'approved') → 'merging' → 'merge_pending' → 'complete'`
   with `completedAt` set. **Never call `prManager.mergePr`** — the parent pod is
   in `merge_pending` and its poller owns the actual PR merge.
4. `cleanupContainer(fixPod, 'fix-pod-pushed')`, emit `pod.completed`.

Extract the rebase block from `approveSession` (`pod-manager.ts:5569–5602`) into
a shared `rebaseAndPush(worktreePath, branch, baseBranch, profile)` helper if it
avoids duplication; otherwise inline — implementer's call, but no copy-paste.

### 6. Active merge re-attempt in `startMergePolling` (`pod-manager.ts:1452`)

The poller already fetches `prManager.getPrStatus()` every tick. Two changes:

a. **Actively re-attempt the merge.** On every tick where the PR is mergeable —
   `status.merged === false && status.open === true && status.ciFailures.length
   === 0 && (!status.reviewDecision || status.reviewDecision === 'APPROVED')` —
   call:

   ```ts
   await mergeQueue.enqueueMerge(profile.repoUrl, baseBranch, async () => {
     const result = await prManager.mergePr({ worktreePath, prUrl });
     if (result.merged) emitActivityStatus(podId, 'PR merged by poller');
   });
   ```

   The existing `status.merged` branch (line 1480) still handles the
   transition to `complete`; this just stops the poller from being purely
   observational.

b. **Enqueue-then-spawn for actionable failures.** Replace the bare
   `maybeSpawnFixSession(podId, status)` at line 1536 with:

   ```ts
   if (status.ciFailures.length > 0 || status.reviewComments.length > 0) {
     const summary = buildActionableFailureSummary(status); // CI + review text, sanitized
     fixFeedbackRepo.enqueue(podId, summary);
     await maybeSpawnFixSession(podId, status);
   }
   ```

   `buildActionableFailureSummary` concatenates CI failure names/annotations and
   review comment bodies — reuse the sanitisation already in `buildPrFixTask`
   (`sanitizeExternal`). This is what makes the queue carry the content so step 4
   can use a minimal status.

The self-heal stale-branch rebase block (lines 1547–1582) stays as-is.

### 7. `spawnFixSession` (`pod-manager.ts:8379`) — keep as a thin wrapper

The `PodManager.spawnFixSession` interface method stays for back-compat, but the
route (step 8) no longer calls it. Trim it to: validate state (merge_pending or
complete, not a fix pod), enqueue the `userMessage` if present via
`fixFeedbackRepo.enqueue`, fetch PR status, call `maybeSpawnFixSession(podId,
status)`. Delete the `reuseFixPod`-conditional `fixPodId` clear (lines 8421–8423)
— always clear stale `fixPodId` is wrong now too; instead let
`maybeSpawnFixSession` step 3 handle terminal fix pods. Drop the
`maxPrFixAttempts` auto-bump or keep it — implementer's call; the queue + cap
logic in `maybeSpawnFixSession` is the source of truth.

### 8. Rewrite `POST /pods/:podId/spawn-fix` (`api/routes/pods.ts:457`)

Zod body, now **required**:

```ts
const spawnFixBody = z.object({ message: z.string().min(1).max(8000) });
```

Handler flow:

1. Look up parent by `:podId` → 404 if missing.
2. `isTerminalState(parent.status)` → `409 { ok: false, reason: 'parent_terminal' }`.
3. `fixFeedbackRepo.enqueue(parent.id, message)`.
4. `await podManager.maybeSpawnFixSession(parent.id, parent.lastPrStatus ??
   <minimal status>)`. Non-blocking: spawns a fix pod iff none is live.
5. Compute response:
   ```ts
   const queueLength = fixFeedbackRepo.count(parent.id);
   const refreshed = podRepo.getPodById(parent.id);
   const fixPodId = refreshed?.fixPodId ?? null;
   const queued = !(
     fixPodId &&
     podRepo.getPodById(fixPodId)?.status === 'provisioning' &&
     queueLength === 1
   );
   ```
6. `202 { ok: true, queued, queueLength, fixPodId }` typed as `SpawnFixResponse`.

The route needs `fixFeedbackRepo` — thread it into `podRoutes(...)` from
`server.ts` the same way `podManager` is. `server.ts` already has the daemon
`db`; build/​pass the repo there.

The handler must **never** call `podManager.spawnFixSession` (the legacy
entrypoint).

### 9. Tests

- `pod-manager.test.ts`: (a) first enqueue + `maybeSpawnFixSession` spawns a fix
  pod; (b) second enqueue while the fix pod is non-terminal does NOT spawn
  another; (c) terminal fix pod + new enqueue recycles via `complete → queued`,
  `fixIteration` bumps; (d) `prFixAttempts >= maxPrFixAttempts` → parent → `failed`;
  (e) `MergeQueue.enqueueMerge` serialises by key.
- `pods.test.ts`: the two `api` ACs above — 3-in-a-row queueing, terminal-parent
  409, missing/empty/oversized body 400, single-message spawn path.
- `pod-lifecycle.e2e.test.ts`: multi-round scenario with mocked
  container/runtime/network — parent → `merge_pending` → enqueue M1 → fix pod
  runs (task contains M1) → fix pod completes (push only, no `mergePr`) →
  enqueue M2 → fix pod recycles (task contains M2) → poller merges → parent →
  `complete`.

## Test expectations

- `npx pnpm --filter @autopod/daemon test` green (AC #5).
- Existing tests asserting the legacy `reuseFixPod` / cooldown branches get
  rewritten or deleted — those code paths are gone.
- The mock-helpers `PodManagerDependencies` object grows `fixFeedbackRepo`;
  every test that builds it inherits the change for free.
- Behavioural anchor: AC #1 drives the canonical queueing flow; a regression to
  silent-no-op fails the response-shape match.
