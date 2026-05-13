# Design — Single Fix Pod Per PR

## Blast radius

### Daemon (`packages/daemon`)

- `src/db/migrations/099_single_fix_pod.sql` *(new)* — creates the
  `pending_fix_feedback` table; drops `profiles.reuse_fix_pod` and
  `profiles.fix_pod_cooldown_sec`. Runs after a pre-migration DB snapshot.
- `src/pods/fix-feedback-repository.ts` *(new)* — CRUD over the new
  table. `enqueue(podId, message)`, `drain(podId)` (returns then deletes),
  `peek(podId)` (returns without deleting — used by the API to report
  `queueLength`), `count(podId)`.
- `src/pods/fix-feedback-repository.test.ts` *(new)* — covers append-only
  ordering, idempotent drain, concurrent enqueue safety (SQLite
  transactions), `count` matches `peek().length`.
- `src/pods/pod-manager.ts` — the largest delta.
  - Rewrite `maybeSpawnFixSession(parentSessionId, status, userMessage?,
    bypassCooldown=false)`: parameter list narrows — `bypassCooldown` and
    `userMessage` are gone (queue handles both concerns). Delete the
    `reuseFixPod` branch (1211–1218), the cooldown guard
    (1244–1258), and the silent-return guard (1193–1206) — the
    last is replaced by an enqueue-into-queue path.
  - On fix-pod *start* (the moment it transitions to `running`), call
    `fixFeedbackRepo.drain(parentPodId)`; pass the concatenated messages
    into `buildPrFixTask(pod, status, podRepo, profile, queued.join('\n\n'))`.
  - On fix-pod *finish-after-push*: skip `approveSession`, transition the
    fix pod directly `pushing → complete`. Parent's merge poller picks up
    the new HEAD on its next tick.
  - Rewrite `startMergePolling` to actively call
    `mergeQueue.enqueueMerge(parent)` on each tick where
    `prManager.getPrStatus()` reports the PR as mergeable. The poller is
    no longer observational.
  - `hasActionableFailures()` (1471–1476) → enqueue path: instead
    of calling `maybeSpawnFixSession` directly, call
    `fixFeedbackRepo.enqueue(parentId, comments.join('\n\n'))` then
    `maybeSpawnFixSession(parentId, status)` (which spawns iff no fix
    pod is alive).
  - Iteration cap (`maxPrFixAttempts`, default 5): when an iteration
    completes and the queue is non-empty AND `fixIteration >=
    maxPrFixAttempts`, transition the parent to `failed` with a clear
    `failReason` ("fix-pod iteration cap exceeded").
- `src/pods/pod-manager.test.ts` — coverage for the rewired paths.
- `src/pods/state-machine.ts` — no transition table change required:
  `complete → queued` is already legal (constants.ts:70).
- `src/pods/pod-lifecycle.e2e.test.ts` — adds a multi-round fix-pod
  scenario that drives the queue end-to-end.
- `src/api/routes/pods.ts` — `POST /pods/:podId/spawn-fix` handler
  rewrite. Always validates `{message: string}` via Zod (non-empty, max
  8000 chars). Always enqueues. Calls `maybeSpawnFixSession`. Returns
  `202 {ok: true, queued: true, queueLength, fixPodId}` on happy path;
  `409 {ok: false, reason: "parent_terminal"}` if parent is in a
  terminal state.
- `src/api/routes/pods.test.ts` — new tests for the response shape +
  the parent-terminal case.

### Shared types (`packages/shared`)

- `src/types/profile.ts` — remove `reuseFixPod` and `fixPodCooldownSec`
  from the `Profile` interface and its Zod schema. Drop-on-cutover; no
  backwards-compat alias.
- `src/types/pod.ts` — add `queueLength?: number` to the `Pod` type for
  serialisation to the desktop. Add the `SpawnFixResponse` type:
  `{ ok: true, queued: boolean, queueLength: number, fixPodId: string |
  null } | { ok: false, reason: 'parent_terminal' }`.
- `src/constants.ts` — `DEFAULT_MAX_PR_FIX_ATTEMPTS` 2 → 5.
- `src/index.ts` — export `FixFeedback`, `SpawnFixResponse`.

### Desktop (`packages/desktop`)

- `Sources/AutopodUI/Models/Profile.swift` — remove
  `fixPodCooldownSec` (Int) and `reuseFixPod` (Bool) fields.
- `Sources/AutopodClient/Types/ProfileResponse.swift` — remove the
  decoder entries (lines 53, 57, 139, 140).
- `Sources/AutopodDesktop/Mapping/ProfileMapper.swift` — remove the
  mapper entries.
- `Sources/AutopodUI/Views/Profiles/ProfileEditorView.swift` — remove
  the form controls (1814–1830 and 2693–2696).
- `Sources/AutopodUI/Views/Profiles/ProfileFieldCatalog.swift` — remove
  the field catalog entry (line 322).
- `Sources/AutopodUI/Models/Pod.swift` — add `queueLength: Int` (default
  0 on decode).
- `Sources/AutopodClient/Types/PodResponse.swift` — decode
  `queueLength` from the daemon JSON.
- `Sources/AutopodUI/Views/Cards/PodCardFinal.swift` — add the queue chip
  next to the iteration chip (around line 213).
- `Sources/AutopodUI/Views/Cards/FixQueuePopover.swift` *(new)* — popover
  view listing queued messages with relative timestamps.
- `Sources/AutopodUI/Views/Detail/SpawnFixSheet.swift` — read
  `SpawnFixResponse` shape; flash green toast with `queueLength` on
  success.

## Seams

| Seam | Owner brief | Contract |
|------|-------------|----------|
| `pending_fix_feedback` table ↔ `FixFeedbackRepository` | 01 | Repository interface (below) |
| `FixFeedbackRepository` ↔ `pod-manager.ts` (drain on iteration start, enqueue on actionable failure) | 02 | Repository interface |
| `pod-manager.ts` ↔ parent PR `mergeQueue.enqueueMerge` (active re-attempt) | 02 | Existing `MergeQueue` API |
| `POST /pods/:podId/spawn-fix` ↔ daemon enqueue + spawn | 03 | `SpawnFixResponse` shape |
| Daemon pod-serialiser ↔ desktop (queue depth on pod payload) | 02 + 05 | `Pod.queueLength` on JSON response |
| Desktop `PodCardFinal` chip ↔ `FixQueuePopover` | 05 | SwiftUI binding on `pod.queueLength` + queue-fetch endpoint |

## Contracts

### `FixFeedbackRepository` (daemon-internal)

```ts
export interface FixFeedback {
  id: string;            // UUID
  podId: string;         // FK → pods.id (the parent pod, not the fix pod)
  message: string;       // <= 8000 chars
  createdAt: number;     // ms epoch
}

export interface FixFeedbackRepository {
  /** Append a message. Returns the new row. */
  enqueue(podId: string, message: string): FixFeedback;

  /** Read without deleting. Caller uses this for `queueLength`. */
  peek(podId: string): FixFeedback[];

  /** Read AND delete in a single SQLite transaction. Caller uses this
   *  at the moment the consuming fix-pod iteration transitions to `running`.
   *  Returns the messages in created-at ascending order. */
  drain(podId: string): FixFeedback[];

  /** Cheap count, used by the pod serialiser. */
  count(podId: string): number;
}
```

Concurrency: SQLite + WAL + a single-process daemon. `enqueue` and `drain`
are both single-statement; the daemon's existing connection serialises
writes. No additional locking required.

### `SpawnFixResponse` (HTTP)

```ts
type SpawnFixResponse =
  | { ok: true; queued: boolean; queueLength: number; fixPodId: string | null }
  | { ok: false; reason: 'parent_terminal' };
```

- `queued: false` only when this is the very first message for this PR AND
  the daemon spawned a brand-new fix pod synchronously (queue was empty
  before this call, and `maybeSpawnFixSession` actually created a fix pod).
  In every other happy path, `queued: true`.
- `queueLength` is the count AFTER this message is appended.
- `fixPodId` is the currently-alive fix pod ID, or `null` if the spawn
  happened synchronously and the message went straight into iteration 1.
- 4xx responses use Fastify's default error shape (`{statusCode, error,
  message}`); the `ok: false` shape is reserved for application-level
  rejections (parent terminal).

### Pod JSON serialisation (response delta)

`GET /pods/:podId` and the WebSocket pod-update payload gain one field:

```ts
queueLength: number;  // 0 if no queued feedback; only meaningful on parents
```

Computed by the serialiser as `fixFeedbackRepo.count(podId)`. Always 0 for
fix pods (queue is keyed on parent pod ID).

## UX flows

The only user-facing change is on the desktop pod card. Brief 05 ships
the chip + popover; the approved wireframe (interview Q6) is below.

```
┌─────────────────────────────────────────────────────────────────────┐
│  ● tragic-marsupial                                  merge_pending   │
│  Branch: feat/payments-redo                          PR #482         │
│                                                                      │
│  [ Fix iteration 2 ]  [ Queue 3 ▾ ]  [ View PR ]  [ Spawn fix… ]    │
│                            │                                         │
│                            ▼  click ─────────────────────┐           │
│                                                          │           │
│                            ┌─────────────────────────────┘           │
│                            │  Queued for next iteration              │
│                            │  ─────────────────────────              │
│                            │  • Address SAST finding #14   2m ago    │
│                            │  • Reviewer: rename foo→bar   8m ago    │
│                            │  • Reviewer: simplify branch  9m ago    │
│                            │                                         │
│                            │  Drains when current fix pod completes  │
│                            └─────────────────────────────────────────│
```

Behaviour notes:

- The chip renders only when `queueLength > 0`. Hidden otherwise.
- The popover is read-only — append-only queue means no edit/delete UI.
- After submitting via `SpawnFixSheet`, the sheet shows a green toast
  ("Queued · position 3") and the chip's count bumps via WebSocket
  pod-update.

Reviewer is the validation anchor for this surface — no `web` AC is
possible against a native macOS UI.

## Reference reading

The executor should consult these before touching code:

- `packages/daemon/CLAUDE.md` → "Pod Lifecycle" + "processPod() — The
  Orchestration Loop" — required context for the lifecycle rewrite.
- `packages/daemon/src/pods/pod-manager.ts` lines 238–322
  (`buildPrFixTask`), 1073 (`DEFAULT_FIX_POD_COOLDOWN_MS`),
  1170–1545 (`maybeSpawnFixSession` + `startMergePolling`),
  5375–5614 (`approveSession` — to understand what the fix pod is
  *no longer* calling), 8180–8257 (`spawnFixSession` entry from API).
- `packages/daemon/src/pods/state-machine.ts` and
  `packages/shared/src/constants.ts:36–76` — confirm `complete →
  queued` is legal (it is).
- `packages/daemon/src/db/migrations/077_reuse_fix_pod.sql` and
  `090_reuse_fix_pod_nullable.sql` — the columns this spec drops.
- `packages/daemon/src/api/routes/pods.ts:457–476` — the existing
  spawn-fix handler.
- `packages/shared/src/types/profile.ts:147–163` and
  `packages/shared/src/types/pod.ts:154–162` — the fields being added
  / removed.
- `packages/desktop/Sources/AutopodUI/Views/Cards/PodCardFinal.swift`
  lines 213–380 — the chip row this spec extends.
- `packages/desktop/Sources/AutopodUI/Views/Detail/SpawnFixSheet.swift`
  — the sheet that posts to `/spawn-fix`.
- `docs/decisions/ADR-007-requeue-recovery.md` — the re-enqueue pattern
  this spec inherits.
- `docs/decisions/ADR-021-sleep-recovery-reconcile-on-wake.md` — why
  daemon-restart works for free with the delete-after-running contract.
- `docs/decisions/ADR-025-single-fix-pod-per-pr.md` *(new, this spec)* —
  the architectural decision in full.
