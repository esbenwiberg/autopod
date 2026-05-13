---
title: "Rewrite POST /pods/:podId/spawn-fix: always enqueue, return queue depth"
depends_on: [01-add-fix-queue-schema]
acceptance_criteria:
  - type: api
    outcome: "POST /pods/:parentId/spawn-fix {message:'a'} three times in a row (all while fix pod running) — all three return 202, final body matches {ok:true, queued:true, queueLength:3, fixPodId:'<same>'}; DB has 3 rows in pending_fix_feedback for parent"
    hint: "supertest the route against a Fastify app; mock the fix pod as 'running' for the duration"
    polarity: pass-on-200
touches:
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/shared/src/types/pod.ts
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/fix-feedback-repository.ts
  - packages/daemon/src/db/migrations/
  - packages/desktop/
---

## Task

Rewrite the `POST /pods/:podId/spawn-fix` handler so it always accepts a
queued message, never silently no-ops, and tells the caller where in the
queue the message landed.

### Current state

`routes/pods.ts:457–476` accepts an optional `userMessage` body,
calls `podManager.spawnFixSession(podId, userMessage)` and returns
`202 OK`. The underlying `spawnFixSession` (~`pod-manager.ts:8180–8257`)
forwards to `maybeSpawnFixSession` — which silently returns at
`pod-manager.ts:1206` when a fix pod is already alive. The user sees
202 either way. This is the bug the spec exists to fix.

### New handler

Request body — Zod-validated:

```ts
const spawnFixBody = z.object({
  message: z.string().min(1).max(8000),
});
```

The body is now **required** and `message` is mandatory. Empty body or
empty string → 400 with Fastify's default error shape.

Handler flow:

1. Look up the parent pod by `:podId`. 404 if missing.
2. If `isTerminalState(parent.status)`, respond
   `409 {ok: false, reason: 'parent_terminal'}`. The `409` is
   intentional — the resource exists but its state forbids the action.
3. `fixFeedbackRepo.enqueue(parent.id, message)`.
4. Call `podManager.maybeSpawnFixSession(parent.id, parent.lastPrStatus)`.
   This is a non-blocking spawn — if no live fix pod, one is created
   (transitions to `queued` and the orchestration loop picks it up).
   If one is alive, this is a no-op.
5. Compute the response:

   ```ts
   const queueLength = fixFeedbackRepo.count(parent.id);
   // Re-read the parent (maybeSpawnFixSession may have updated fixPodId).
   const refreshedParent = podRepo.getPodById(parent.id);
   const fixPodId = refreshedParent?.fixPodId ?? null;
   const queued = !(fixPodId &&
     podRepo.getPodById(fixPodId)?.status === 'provisioning' &&
     queueLength === 1);
   ```

   `queued: false` only fires when this is the very first message AND
   the daemon synchronously spawned a new fix pod that's already
   `provisioning` (i.e. drain will happen in the same iteration, no
   recycle needed).

6. Respond `202 {ok: true, queued, queueLength, fixPodId}`.

### Shared type

`packages/shared/src/types/pod.ts`: the `SpawnFixResponse` type from
brief 01 is the canonical contract. The route handler MUST type the
response payload as `SpawnFixResponse` (Fastify's `reply.send()` is
typed via the route declaration's `Reply` generic). This keeps the
desktop's `SpawnFixSheet` decoder in lockstep — see brief 05.

### Tests (`pods.test.ts`)

Use `app.inject()` against a Fastify app built with `createTestDb()`
and mocked `PodManager` (the mock-helpers factory updated in brief 02).

- POST with missing body → 400.
- POST with `message: ''` → 400.
- POST with `message: 'x'.repeat(8001)` → 400.
- POST against a terminal parent (`status: 'complete'`) → 409 with
  `{ok: false, reason: 'parent_terminal'}`.
- POST against a parent with no live fix pod → 202 with
  `{ok: true, queued: false, queueLength: 1, fixPodId: <new pod id>}`
  AND `fixFeedbackRepo.count(parent.id)` returns 1 AND
  `podManager.maybeSpawnFixSession` was called once.
- POST against a parent with a live fix pod (status `running`) — three
  consecutive calls → all return 202 with monotonically increasing
  `queueLength` (1, 2, 3) and the SAME `fixPodId` AND the DB has 3 rows.
- POST without authentication (in production mode) → 401. Dev mode
  accepts all tokens per the existing auth-stub behaviour.

### What this brief MUST NOT touch

- `pod-manager.ts` — brief 02 owns the consumer-side changes
  (`maybeSpawnFixSession` rewrite, lifecycle, merge poller). This
  brief just calls the new method signature.
- `fix-feedback-repository.ts` — brief 01 owns the implementation.

## Test expectations

- All existing route tests in `pods.test.ts` stay green; new tests
  exercise the new shape.
- `app.inject({method:'POST', url:'/pods/:id/spawn-fix', payload:{}})`
  is the canonical test pattern in this file — match it.
- Behavioural anchor: AC #1 (api) drives the three-in-a-row queueing
  flow. A regression to silent-no-op fails on the body shape match
  (response is missing `queueLength`).
- The handler must NEVER call `podManager.spawnFixSession` (the legacy
  entrypoint) — call `maybeSpawnFixSession` directly. The legacy method
  may be deleted entirely; if it is referenced elsewhere, leave it as
  a thin wrapper but ensure this route does not use it.
