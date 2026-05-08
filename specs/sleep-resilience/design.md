# Design — Sleep resilience

## Blast radius

**`@autopod/shared`**
- `packages/shared/src/types/events.ts` — add `HostResumedEvent` to the
  `SystemEvent` union.
- `packages/shared/src/types/pod.ts` — add `lastRecoveryTrigger?: 'wake' | 'restart' | null` to `Pod`.
- `packages/shared/src/index.ts` — export new types if not auto-exported.

**`@autopod/daemon`**
- `packages/daemon/src/db/migrations/092_pod_last_recovery_trigger.sql`
  (new) — `ALTER TABLE pods ADD COLUMN last_recovery_trigger TEXT`.
- `packages/daemon/src/pods/pod-repository.ts` — `rowToPod`, INSERT,
  UPDATE plumb `lastRecoveryTrigger`.
- `packages/daemon/src/pods/sleep-detector.ts` (new) — tick-gap +
  macOS power-notification adjunct; emits `HostResumedEvent` via
  `eventBus`.
- `packages/daemon/src/pods/sleep-detector.test.ts` (new).
- `packages/daemon/src/pods/local-reconciler.ts` — accept
  `trigger: 'restart' | 'wake'`; skip `MAX_RECOVERIES` cap when wake;
  stamp `lastRecoveryTrigger` on the pod row.
- `packages/daemon/src/pods/pod-manager.ts` —
  - subscribe to `host.resumed`, call `reconcileLocalSessions({ trigger: 'wake' })`;
  - in the validation entry, skip `validationAttempts` increment when
    `pod.lastRecoveryTrigger === 'wake'` and clear the flag;
  - for non-Claude runtimes resuming via `recoveryWorktreePath`, append
    a wake-correction postscript to the resumed task prompt;
  - stuck-pod watchdog subscribes to `host.resumed`, suppresses checks
    for `WAKE_GRACE_MS` (60 s).
- `packages/daemon/src/runtimes/stream-grace.ts` — idle-liveness probe
  treats a wake signal as activity (resets idle timer in place).
- `packages/daemon/src/index.ts` — start the sleep-detector at daemon
  startup, alongside `startStuckPodWatchdog()`.

**`packages/desktop`**
- `packages/desktop/Sources/AutopodClient/Types/EventTypes.swift` — add
  `case hostResumed(...)` to the typed `SystemEvent` enum and parse
  it in `parse(_ raw: RawSystemEvent)`.
- `packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift` —
  surface the latest `host.resumed` event for the UI (e.g. as a
  published property).
- `packages/desktop/Sources/AutopodUI/Views/Shared/HostResumeBanner.swift`
  (new) — transient banner; mirror the `WorktreeCompromisedBanner`
  style at `Views/Detail/OverviewTab.swift:25`.

## Seams

The whole feature pivots on a single new event:

```
sleep-detector ──host.resumed──▶ eventBus ──┬──▶ pod-manager.subscribe()
                                            │     ├─▶ reconcileLocalSessions({ trigger: 'wake' })
                                            │     └─▶ stuck-pod watchdog: arm grace window
                                            ├──▶ stream-grace idle-probe: reset idle timer
                                            └──▶ websocket → desktop EventStream → banner
```

Brief boundaries follow this seam structure:
- **Brief 01** owns the detector + the event type. Pure producer.
- **Brief 02** owns the reconciler + processPod consumers (cap exemption,
  postscript, persistence column).
- **Brief 03** owns the watchdog + idle-probe consumers (grace window).
- **Brief 04** owns the desktop consumer (banner).

## Contracts

### `HostResumedEvent` (shared/src/types/events.ts)

```ts
export interface HostResumedEvent {
  type: 'host.resumed';
  timestamp: string;
  sleptMs: number;
  detector: 'tick-gap' | 'pmset' | 'native';
  reconciledPodIds: string[]; // populated by pod-manager after reconcile,
                              // empty at initial emit
}
```

The detector publishes the event with `reconciledPodIds: []`. The
pod-manager subscriber re-publishes a richer `host.resumed.completed`
event after the reconciler returns, OR mutates a shared structure the
desktop reads. Brief 02 picks one — see "Race conditions" below.

### Reconciler trigger (local-reconciler.ts)

```ts
export type ReconcileTrigger = 'restart' | 'wake';

export interface LocalReconcilerDependencies {
  // ... existing fields
  trigger?: ReconcileTrigger; // default 'restart' for backwards compat
}
```

When `trigger === 'wake'`:
- `MAX_RECOVERIES` cap is **not** enforced and `recoveryCount` is **not**
  incremented.
- The pod row is stamped with `lastRecoveryTrigger = 'wake'` before
  re-enqueue.

### `Pod.lastRecoveryTrigger` (shared/src/types/pod.ts)

```ts
lastRecoveryTrigger?: 'wake' | 'restart' | null;
```

One-shot. Set by reconciler. Read by `processPod()` validation entry
(see `pod-manager.ts:6325`). Cleared after first validation entry
post-recovery so subsequent validation attempts increment normally.

### Wake-correction postscript

For non-Claude runtimes recovering via `recoveryWorktreePath`, append
this to the resumed task prompt:

```
Note: this run was interrupted by a host sleep and restarted. Some
work may already be on disk — check `git log` and `git diff main`
before continuing.
```

Only fires when both `pod.recoveryWorktreePath` is set AND
`pod.lastRecoveryTrigger === 'wake'` AND `runtime !== 'claude'`. Claude
gets full conversation context via `claude_session_id` resume and
doesn't need the hint.

## UX flows

**On wake (desktop user perspective):**

1. User opens lid; daemon wakes; sleep-detector ticks, emits
   `host.resumed` with `sleptMs` and `detector`.
2. Pod-manager calls `reconcileLocalSessions({ trigger: 'wake' })`.
   Eligible pods transition to `queued` with `recoveryWorktreePath` set.
3. Within 60 s, the queue dispatches them into `provisioning`. Old
   containers killed; new containers spawned; existing worktrees
   mounted; Claude sessions resume via `--resume <session_id>`.
4. Desktop shows a transient banner at the top of the main window:
   `Resumed after Xm — N pods OK`. Self-dismisses after 5 s; click to
   dismiss earlier.
5. Pod cards in the UI flash through the normal `queued → provisioning
   → running` animation. No special UX beyond the banner.

**Loading / empty / error states:**
- If wake fires with zero eligible pods, the banner reads
  `Resumed after Xm` (no pod count).
- If reconcile errors for a specific pod (rare), the existing
  `markSessionKilled` path runs; the desktop shows that pod's
  failed state with normal animation.

## Reference reading

- `packages/daemon/src/pods/local-reconciler.ts:33` — existing
  reconciler this work extends. Same function, new caller, new
  parameter.
- `packages/daemon/src/pods/local-reconciler.ts:213` —
  `MAX_RECOVERIES = 3`. Wake-recovery skips this check.
- `packages/daemon/src/pods/pod-manager.ts:8273` —
  `startStuckPodWatchdog`. Needs sleep-awareness in brief 03.
- `packages/daemon/src/pods/pod-manager.ts:6325` — validation entry
  point where `validationAttempts` increments. Brief 02 adds the
  `lastRecoveryTrigger === 'wake'` skip here.
- `packages/daemon/src/runtimes/stream-grace.ts:255` —
  `withIdleLivenessProbe`. Idle timer reset on wake in brief 03.
- `packages/daemon/src/pods/pod-manager.ts:1561` — commit polling loop.
  No change required: the loop self-heals on the next tick after wake.
  (Documented here so the executor doesn't go looking for it.)
- `packages/daemon/CLAUDE.md` "Recovery mode" section — explains how
  `recoveryWorktreePath` flips `processPod()` into recovery branch.
  Wake-recovery uses the same branch unchanged.
- `packages/daemon/CLAUDE.md` "Adding a New Pod State" — not
  applicable here; no new pod states are added.
- `docs/decisions/ADR-007-local-recovery-requeue-not-resume.md` —
  precedent: re-queue over in-place resume on daemon restart. Wake
  follows the same shape.
- `docs/decisions/ADR-008-local-recovery-kill-old-container-always.md` —
  precedent: orphan containers are always killed and respawned. Wake
  follows the same shape.
- `docs/decisions/ADR-021-sleep-recovery-via-reconcile-on-wake.md`
  (introduced) — full rationale for choosing reconcile over forgive +
  cap-exemption decision.
- `packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift:25`
  + `WorktreeCompromisedBanner` — pattern the wake banner mirrors.
- `packages/desktop/Sources/AutopodClient/Types/EventTypes.swift:120` —
  `SystemEvent` typed enum the new `case hostResumed(...)` goes into.

## Race conditions

Three are worth pinning. Briefs MUST handle them or the failure modes
will land in production.

### 1. Stuck-pod watchdog firing before the wake handler

The stuck-pod watchdog ticks every 60 s. The sleep-detector ticks every
30 s. After wake, both timers fire as the event loop catches up; the
watchdog might run first. Without protection, a pod with
`lastAgentEventAt` 4 hours ago gets force-failed before reconcile lands.

**Resolution (brief 03):** the watchdog subscribes to `host.resumed` and
records `lastWakeAt`. In its tick, if `Date.now() - lastWakeAt < WAKE_GRACE_MS`
(60 s), it skips all pods this tick with a debug log.

### 2. In-flight `processPod()` loop when wake fires

A pod in `running` likely has a `processPod()` invocation suspended on a
dead `containerManager.exec()` or runtime stream. When the reconciler
transitions the pod to `queued`, the in-flight invocation may still be
holding promises that will eventually error and try to mutate the pod
row.

**Resolution (brief 02):** the reconciler synchronously transitions the
pod to `queued` first. Most `processPod()` await points are followed by
state checks (e.g. status comparisons before the next transition); the
loop sees the changed state and returns cleanly. If any await point
lacks a state check, brief 02 introduces a per-pod `AbortController`
mirroring `validationAbortControllers` (`pod-manager.ts:1069`). Plumb
the abort signal through `containerManager.exec()` and runtime calls.

### 3. Multiple wake events from tick-gap and macOS adjunct

On macOS, both the tick-gap heuristic and the power-notification
adjunct may detect the same wake within a few seconds of each other.
Without dedupe, the reconciler runs twice, the banner toasts twice.

**Resolution (brief 01):** the sleep-detector dedupes internally.
After publishing a `host.resumed` event, ignore further wake signals
within 5 s. The first detector wins; later signals are noise.

## Decisions

- **ADR-021** — Sleep-recovery via reconcile-on-wake (introduced; this
  spec).
- **ADR-007** — Re-queue over resume (existing; wake-recovery uses the
  same path).
- **ADR-008** — Always kill old container, spawn fresh (existing;
  wake-recovery uses the same path).
