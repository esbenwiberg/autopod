# Single Fix Pod Per PR

## Problem

Fix pods today spawn as a fresh child pod every time the parent's merge poller
detects an actionable failure (CI red, `CHANGES_REQUESTED` review, blocking
review comment). Each child carries its own `linkedPodId` back to the parent
and runs its own merge attempt through `approveSession`.

This produces three concrete failure modes today:

1. **Pile-up.** Observed in the field: two pods (`tragic-marsupial`,
   `holy-haddock`) both stuck in `merge_pending` with merge conflicts. With
   `reuseFixPod: false` (the historical default) the daemon happily spawns
   N children per PR. With `reuseFixPod: true` the path partially works but
   is gated behind a `fixPodCooldownSec` window and an "is a fix pod alive?"
   guard that silently rejects spawn attempts.
2. **Silent UX failures.** `POST /pods/:podId/spawn-fix` always returns
   `202 OK` — even when the underlying `maybeSpawnFixSession` silently
   returns at `pod-manager.ts:1206` because a fix pod is already alive.
   The user-visible result: a SAST tool's review comments spawn a fix pod,
   the human reviewer then adds more comments, the human clicks "Spawn fix"
   in the desktop, the daemon shrugs and the new comments never make it
   into the agent's task.
3. **Ambiguous merge ownership.** Both the parent pod's poller and the fix
   pod's `approveSession` are wired to call `mergePr`. The parent's poller
   is observational (it watches PR state) but doesn't actively re-attempt
   merges that became viable after the fix pod pushed a fix; that
   responsibility was implicitly the fix pod's via its merge path. Net
   effect: PRs that *could* merge after a successful fix often need another
   nudge (manual or merge-queue-driven) to actually merge.

The `reuseFixPod` profile flag and `fixPodCooldownSec` field
(migrations `077` and `090`) were partial steps toward this design — they
made the right behaviour opt-in. This spec makes it the only behaviour and
finishes the work.

## Outcome

One canonical fix pod per parent PR. Every round of feedback — SAST
comments, CI failures, reviewer comments, manual user prompts — is recorded
as an append-only queue entry and consumed by the next iteration of the
single fix pod for that PR. The parent pod owns merging and actively
re-attempts it; the fix pod owns code changes and pushes to the branch,
then completes.

## Users

- **The user** running pods locally — primary beneficiary. No more piling
  fix pods. Manual "Spawn fix" while one is running queues the message and
  the desktop tells you where in the queue it landed.
- **Reviewer tooling (SAST, CI, human reviewers)** — comments arriving in
  any order, before or during a fix-pod iteration, all land deterministically
  in some iteration's task. No order-dependent loss.
- **Operators reading pod-manager telemetry** — single fix-pod chain per PR,
  with a clear `fixIteration` counter and a queue depth field. Easier to
  reason about than the current N-child-pod fan-out.

## Success signal

Three observable signals, each tied to a brief AC:

1. **Queue → iteration delivery.** Every queued message lands in some
   fix-pod iteration's task description before the parent pod is merged or
   fails. Two messages enqueued back-to-back (one before iteration N starts,
   one during iteration N) result in iteration N's task containing the
   first message and iteration N+1's task containing the second. *(Brief 02
   AC, `type: api`.)*
2. **Manual spawn confirms queue position.** `POST /pods/:podId/spawn-fix`
   always responds with `{ok: true, queued: true, queueLength: N,
   fixPodId: string | null}` on success. The "silent 202" failure mode
   is gone. *(Brief 03 AC, `type: api`.)*
3. **Schema supports queue.** Migration `099_single_fix_pod` creates the
   `pending_fix_feedback` table and drops the deprecated profile columns.
   Shared types no longer expose `reuseFixPod` / `fixPodCooldownSec`.
   *(Brief 01 AC, `type: cmd`.)*

The desktop chip + popover UX is reviewer-judged against the approved
wireframe in `design.md` → UX flows. No `web` AC is possible against a
native macOS app.

## Non-goals

- **No live mid-run message injection.** Messages arriving while a fix pod
  is `running` sit in the queue and feed the **next** iteration (via the
  already-legal `complete → queued` recycle). We do not poke a live agent
  via MCP `check_messages` to consume the queue mid-run. Out of scope.
- **No merge-thread gating.** This spec does not change whether the parent
  merges when review threads are unresolved; that is orthogonal plumbing
  in `pr-manager` / `ado-pr-manager`. Out of scope.
- **No `linkedPodId` refactor.** Fix pods still set `linkedPodId` to the
  parent pod and inherit `prUrl`. This spec only changes how many of them
  exist and what they do on completion. The relational shape stays.
- **No raising / lowering `maxPrFixAttempts` per-profile.** Default goes
  from 2 → 5 (cooldown removal means iterations are cheaper); profile-level
  override stays intact at the existing column. Cap-bumping UX is out of
  scope.
- **No backfill or migration of in-flight fix pods.** If a fix pod is
  running when the daemon upgrades, the new code treats it as the canonical
  fix pod for that PR. The queue is empty until the next reviewer message
  lands. Acceptable.
- **Workspace pods are unaffected.** They have no agent, no validation,
  no PR; the entire fix-pod lifecycle is irrelevant.

## Glossary

- **Fix pod** — a pod spawned to address actionable PR failures after the
  parent has reached `merge_pending`. Carries `linkedPodId` to the parent;
  inherits `prUrl`; runs the same runtime as the parent but with a
  task-description scoped to "fix these review comments / CI failures".
- **Canonical fix pod** — the one and only fix pod per parent PR after
  this spec lands. Identified on the parent as `fixPodId`. Recycled across
  iterations via the legal `complete → queued` transition.
- **Iteration** — one full run of the canonical fix pod, from `queued` to
  `complete`. Tracked by the existing `pods.fix_iteration` column. Caps at
  `maxPrFixAttempts` (default 5 after this spec).
- **Feedback queue** — append-only list of free-text messages awaiting
  injection into the next fix-pod iteration. Stored in
  `pending_fix_feedback`. Drained on iteration `running` start.
- **Queued message** — one row in the feedback queue. Carries the parent
  pod's ID, a message string (max 8000 chars), and a created-at timestamp.
- **Actionable failure** — the existing `hasActionableFailures()` predicate
  in `pod-manager.ts:1471–1476`. Triggers automatic enqueue from the
  merge poller. Unchanged by this spec.
- **Delete-after-running** — the contract that queued messages are deleted
  from the DB only after the consuming fix-pod iteration successfully
  transitions to `running`. If the daemon restarts before then, the
  messages remain queued for the next iteration. This is what makes
  daemon-restart recovery free (see ADR-021 ↔ ADR-025).

## Reversibility

Migration `099_single_fix_pod` does two things: (a) creates the
`pending_fix_feedback` table — fully reversible by dropping it; (b) drops
the `profiles.reuse_fix_pod` and `profiles.fix_pod_cooldown_sec` columns,
which is hard-to-reverse without a snapshot.

**Mandatory pre-migration step**: the migration runner must copy the live
DB to `packages/daemon/backups/<timestamp>-pre-single-fix-pod.db` before
running `099_single_fix_pod.sql`. Precedent: same pattern is used in
`091_drop_screenshot_blobs.sql` (see `specs/proof-of-work-screenshots/
purpose.md` → Reversibility).

**Rollback procedure**:

1. Stop the daemon.
2. Restore the snapshot DB to replace `autopod.db`.
3. Revert daemon code to the commit prior to brief 02 landing (this
   undoes the lifecycle rewrite — the legacy spawn-new-child path resumes).
4. Revert desktop code to a build that still reads
   `reuseFixPod` / `fixPodCooldownSec` from the profile response.
5. Restart daemon.

After rollback: legacy fix-pod-per-failure behaviour resumes; any
messages that had been enqueued in `pending_fix_feedback` between cutover
and rollback are discarded. Single-user blast radius makes this an
acceptable cost.
