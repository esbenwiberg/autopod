# ADR-025: Single fix pod per PR — recycled across all feedback rounds

## Status

Accepted

## Context

Fix pods today are spawned per actionable PR failure: each round of
review comments or CI failure creates a fresh child pod that carries
`linkedPodId` back to the parent, runs its own merge attempt via
`approveSession`, and either pushes a fix or fails.

Three failure modes emerge from this design:

1. **Pile-up.** With the historical `reuseFixPod: false` default,
   nothing prevents N children per PR. Observed in the field: parent
   pods (`tragic-marsupial`, `holy-haddock`) both stuck in
   `merge_pending`, each having spawned a chain of fix children with
   merge conflicts on the same branch. Migration `077_reuse_fix_pod`
   added the `reuseFixPod` profile flag as an opt-in fix; migration
   `090_reuse_fix_pod_nullable` softened it but didn't make it the
   default.
2. **Silent UX failures.** `POST /pods/:podId/spawn-fix` always returns
   `202 OK`. The underlying `maybeSpawnFixSession` (`pod-manager.ts:
   1193–1206`) silently returns when a fix pod is already alive —
   the user clicks "Spawn fix" in the desktop, gets a 202, and the
   message vanishes. Observed: a SAST tool's comments spawn a fix pod,
   a human reviewer then adds more comments, the human's manual spawn
   is silently swallowed.
3. **Ambiguous merge ownership.** Both the parent pod's `startMerge
   Polling` and the fix pod's `approveSession` path call `mergePr`.
   The parent's poller is observational — it watches PR state but
   does not actively re-attempt merges that became viable after a fix
   pod pushed. The fix pod was the implicit re-attempter via its own
   merge path; with the cooldown/no-spawn guards this gets fragile.

The cooldown field `fixPodCooldownSec` (also added by `077`) compounded
the problem — it stopped pile-ups by gating spawn time, but also gated
the desktop's manual "Spawn fix" requests with no UX feedback.

## Decision

One canonical fix pod per parent PR. Replace the legacy spawn-new-child
path with a single long-lived fix pod that re-enqueues itself via the
already-legal `complete → queued` transition on each round of feedback,
draining a `pending_fix_feedback` queue on every `running` start. Fix
pods complete after `git push` — they do **not** call `approveSession`;
merge ownership stays with the parent pod's poller, which now actively
re-attempts the merge instead of just observing.

Specifically:

- **`pending_fix_feedback` table** (`pod_id`, `message`, `created_at`)
  added by migration `099_single_fix_pod`. Append-only.
- **`FixFeedbackRepository`** with `enqueue` / `peek` / `drain` /
  `count` methods. `drain` is a single SQLite transaction.
- **`maybeSpawnFixSession`** rewritten: if no live fix pod, create one
  and let the orchestration loop drain the queue when it transitions
  to `running`. If a live fix pod exists, do nothing (the caller has
  already enqueued).
- **`POST /pods/:podId/spawn-fix`** always enqueues, always returns
  `202 {ok: true, queued, queueLength, fixPodId}` (or `409 {ok: false,
  reason: 'parent_terminal'}`).
- **Fix pod completes after push.** No `approveSession` call. The
  parent's merge poller picks up the new HEAD on its next tick and
  actively calls `mergeQueue.enqueueMerge(parent)` if the PR is
  mergeable.
- **Iteration cap** raised 2 → 5 (`DEFAULT_MAX_PR_FIX_ATTEMPTS`).
  Exceeding the cap fails the parent pod with a clear `failReason`.
- **Profile fields `reuseFixPod` and `fixPodCooldownSec`** dropped
  entirely. Behaviour is unconditional now; no profile-level override.

The **delete-after-running** contract: queued messages are deleted from
the DB only after the consuming fix-pod iteration's `running`
transition is committed. If the daemon crashes between `provisioning`
and `running`, the SQLite transaction rolls back and messages remain
queued. This is what makes daemon-restart recovery free — no new
reconciler hook required.

## Consequences

### Beneficial

- No more "5 fix pods spinning" pile-up. One fix pod per PR, recycled.
- Mid-flight reviewer comments queue and feed the next iteration
  deterministically. No order-dependent message loss.
- Manual `POST /spawn-fix` always succeeds (or returns a typed `ok:
  false`) and tells the caller the queue depth. Silent 202 is gone.
- Ambiguous merge ownership resolved: parent owns merge, fix pod owns
  code changes.
- Daemon-restart recovery is free via the delete-after-running
  contract (aligns with ADR-021 reconcile-on-wake).

### Harmful

- Messages arriving while a fix pod is mid-run wait for the next
  iteration — no live injection. The user's mental model has to shift
  from "click and the agent sees it" to "click and it's queued for the
  next round." Toast text on `SpawnFixSheet` mitigates by surfacing
  queue position.
- Migration `099` drops `profiles.reuse_fix_pod` and `profiles.
  fix_pod_cooldown_sec`. Rollback requires re-adding the columns as
  nullable AND restoring a pre-migration DB snapshot AND reverting
  daemon + desktop code. Single-user blast radius.

### Configurable

- Iteration cap raised 2 → 5 by constant change; per-profile override
  remains via the existing `maxPrFixAttempts` column. No new tunable
  introduced.
- Queue is append-only at the data layer AND at the UI. No edit / delete
  affordances. The append-only choice is what makes recovery and
  semantics simple — adding edit/delete later would re-introduce
  ordering decisions.

## Alternatives rejected

### Keep spawning child fix pods, deduplicate at the spawn layer

Solves the pile-up by short-circuiting spawn when a child is alive,
but leaves the silent-no-op spawn UX bug and the dual-merge-owner
ambiguity. `linkedPodId` + cooldown grew exactly because the spawn
semantics were wrong — patching them further compounds rather than
fixes. Rejected.

### Live-inject queue messages into a running fix pod via MCP

The `check_messages` MCP tool already exists; we could push queued
messages to a live agent mid-run. Possible, but breaks the "task is the
contract" model — agents would race the queue, and the iteration's
work-product becomes a function of queue timing rather than its task
description. Hard to debug, hard to reason about. Marked an explicit
non-goal of the spec.

### Gate parent merge on resolved review threads

A common request in PR-tooling circles. Orthogonal to fix-pod
plumbing — could live in `pr-manager` / `ado-pr-manager` without
touching the fix-pod lifecycle. Out of scope; tracked as a separate
potential spec.

## Related ADRs

- **ADR-007: re-queue recovery instead of dedicated resume path** — the
  `complete → queued` transition this spec leans on is the same
  pattern used for daemon-restart recovery. Aligned, no conflict.
- **ADR-021: sleep-recovery via reconcile-on-wake** — queued messages
  persist across daemon restart by virtue of being SQLite rows; the
  reconciler picks up a fix pod whose iteration was cut short and the
  queue remains intact. No new reconciler hook required.

## References

- Spec: `specs/single-fix-pod/`
- Brief 01: `specs/single-fix-pod/briefs/01-add-fix-queue-schema.md`
- Brief 02: `specs/single-fix-pod/briefs/02-rewire-fix-pod-lifecycle.md`
- Brief 03: `specs/single-fix-pod/briefs/03-update-spawn-fix-api.md`
- Brief 04: `specs/single-fix-pod/briefs/04-desktop-remove-deprecated-profile-fields.md`
- Brief 05: `specs/single-fix-pod/briefs/05-desktop-fix-queue-ui.md`
- Pre-existing fields being removed: migrations `077_reuse_fix_pod.sql`,
  `090_reuse_fix_pod_nullable.sql`.
