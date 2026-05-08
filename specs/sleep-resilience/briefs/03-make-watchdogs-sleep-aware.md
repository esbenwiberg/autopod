---
title: "Make stuck-pod watchdog and idle-liveness probe sleep-aware"
depends_on: [01-add-sleep-detector, 02-wire-wake-aware-reconciler]
acceptance_criteria: []
touches:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/runtimes/stream-grace.ts
  - packages/daemon/src/runtimes/stream-grace.test.ts
does_not_touch:
  - packages/daemon/src/pods/local-reconciler.ts
  - packages/daemon/src/pods/sleep-detector.ts
  - packages/shared/src/types/events.ts
---

## Task

Add a 60 s grace window after every `host.resumed` event during which
the existing "you've been silent for X" failure paths are suppressed.
Without this, the watchdog and idle-probe race the reconciler and
force-fail pods that are about to be cleanly recovered.

### Scope, in detail

**1. Stuck-pod watchdog grace window (`pod-manager.ts:8273`).**

The `startStuckPodWatchdog()` returns an idempotent installer. Augment
its closure with a `lastWakeAt: number | null = null`. Subscribe to the
event bus for `host.resumed`:

```ts
eventBus.subscribe((event) => {
  if (event.type === 'host.resumed') {
    lastWakeAt = Date.now();
  }
});
```

In the existing `tick()`, before iterating running pods:

```ts
const WAKE_GRACE_MS = 60_000;
if (lastWakeAt !== null && Date.now() - lastWakeAt < WAKE_GRACE_MS) {
  logger.debug(
    { sinceWakeMs: Date.now() - lastWakeAt },
    'Watchdog: skipping tick during wake grace window',
  );
  return;
}
```

After grace elapses, the watchdog resumes normal behaviour. There's no
need to permanently bump `lastAgentEventAt` on every running pod —
during the 60 s grace window the reconciler has already transitioned
the affected pods to `queued`, so the watchdog's `running`-only filter
won't see them anyway. The grace window protects only against
*ordering* races on the wake tick.

**2. Idle liveness probe wake awareness (`stream-grace.ts:255`).**

The `withIdleLivenessProbe` async-generator wraps a runtime stream and
runs an exec probe if no event arrives for `idleTimeoutMs`. After
wake, the stream is dead, so the probe will run, fail (container is
still paused or dead), and emit a fatal-error event — *exactly* the
false-fail we want to avoid.

Two layered fixes:

a. **Reset on wake.** Pass an optional wake signal into the probe.
   Easiest shape: add a third element to the timer race that resolves
   when a wake event arrives, treated identically to a successful
   `next` (resets the idle timer):

   ```ts
   type RaceResult =
     | { kind: 'next'; result: IteratorResult<AgentEvent> }
     | { kind: 'idle' }
     | { kind: 'wake' };

   const winner = await Promise.race<RaceResult>([
     pendingNext.then((result) => ({ kind: 'next' as const, result })),
     idle.then(() => ({ kind: 'idle' as const })),
     wake.then(() => ({ kind: 'wake' as const })), // resolves when host.resumed fires
   ]);

   if (winner.kind === 'wake') {
     // Re-arm idle timer; keep pendingNext alive; loop.
     continue;
   }
   ```

   The `wake` promise is constructed from a `host.resumed` subscription
   passed as a new optional dependency: `wakeSignal?: AsyncIterable<void>`
   or `onWake?: () => Promise<void>`. The caller (probably `pod-manager.ts`
   wiring) supplies it via the event bus. If `wakeSignal` is omitted,
   the probe behaves exactly as today.

b. **Container still paused?** If the wake fires but the container
   wasn't reachable (e.g. Docker hasn't resumed it yet), don't escalate
   to fatal — let the reconciler's downstream kill+respawn handle it.
   The grace-window logic in (a) already does this: a wake event resets
   the idle timer and we loop back, giving the reconciler time to
   transition the pod out of `running`. When the pod is no longer the
   probe's concern, the upstream stream consumer ends naturally.

**3. Wiring in `pod-manager.ts`.**

Where the runtime stream is wrapped with `withIdleLivenessProbe`, plumb
the wake signal:

- Convert the event bus subscription into an `AsyncIterable<void>` (or
  a one-shot promise that re-arms after each emit) and pass it as
  `wakeSignal`.
- Each pod's stream wraps with its own subscription so cleanup is
  per-stream.

Pick whichever shape (`AsyncIterable` or `onWake` promise) is cleanest
for the existing callsites. Don't refactor the whole probe API; minimum
addition.

## Touches

- `packages/daemon/src/pods/pod-manager.ts` — watchdog grace; pass
  wake signal into idle-probe callsites.
- `packages/daemon/src/pods/pod-manager.test.ts` — watchdog grace tests.
- `packages/daemon/src/runtimes/stream-grace.ts` — `withIdleLivenessProbe`
  accepts optional wake signal.
- `packages/daemon/src/runtimes/stream-grace.test.ts` — idle-probe wake
  tests.

## Does not touch

- `packages/daemon/src/pods/local-reconciler.ts` — owned by brief 02.
- `packages/daemon/src/pods/sleep-detector.ts` — owned by brief 01.
- `packages/shared/src/types/events.ts` — owned by brief 01.

## Constraints

- `WAKE_GRACE_MS = 60_000` — match the spec's design.md exactly. Don't
  invent your own constant.
- Watchdog grace is a skip, not a permanent bump. After 60 s, normal
  behaviour resumes — pods that *legitimately* went silent during the
  grace window will be detected on the next tick.
- Idle-probe wake signal is **optional**. Existing callsites that
  don't pass it MUST continue working exactly as today. Add tests
  for the no-wakeSignal path to guarantee no regression.
- Do NOT change `idleTimeoutMs` or `probeTimeoutMs` semantics. The
  wake signal is a new "activity" source; the existing timeouts
  remain.
- Don't introduce a synchronous read of `Date.now()` on every probe
  tick if avoidable — the timer race already gives us the wake-time
  signal cleanly.

## Test expectations

In `pod-manager.test.ts`:

- Pod with `lastAgentEventAt` 4 hours ago, threshold 30 min → in a
  normal tick, watchdog transitions the pod to `failed`.
- Same pod, but a `host.resumed` event was published 5 s ago →
  watchdog tick skips the pod (debug log), pod stays `running`.
- 65 s after the wake event, watchdog tick runs normally and *does*
  transition the silent pod to `failed`.
- Multiple wake events in quick succession → each refreshes the grace
  window from its own timestamp.
- No wake events ever → existing watchdog behaviour is unchanged.

In `stream-grace.test.ts`:

- Existing test cases continue to pass (no `wakeSignal` passed →
  identical behaviour).
- Probe with `wakeSignal`: feed events at 9 min, then trigger wake at
  9 min 30 s; idle timer resets; at 19 min total elapsed (10 min after
  wake), no probe fires (because activity happened at 9 m + wake at
  9 m 30 s).
- Probe with `wakeSignal`: 11 min of silence WITH no wake → existing
  probe path fires (regression guard for wake-signal not stealing
  control).
- Probe with `wakeSignal`: wake fires *during* a probe-timeout race,
  AFTER the idle elapsed but BEFORE the probe call resolves —
  document and pick a reasonable behaviour (recommended: wake
  signal cancels the probe-in-flight via the existing `probeTimeoutMs`
  race; the iterator continues).

## Risks / pitfalls

- `pod-manager.ts` is ~8500 lines and brief 02 also modifies it.
  Sequence 03 *after* 02 to avoid merge conflicts.
- The async-generator timer race in `stream-grace.ts:278` is subtle —
  `pendingNext` must stay alive across `wake`/`idle` iterations or
  iterator semantics break (double-call to `iterator.next()`). The
  existing code handles this for `idle`; mirror the same pattern for
  `wake`.
- Don't accidentally make the wake signal "consumable once" — it must
  re-arm each iteration. A one-shot promise that's recreated each
  iteration works; a stale promise cached at function entry does not.
- Watchdog grace risk: a 60 s window is short enough that a
  legitimately wedged pod gets caught in the next tick. If you find
  yourself making it longer, you've found a design issue — escalate.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
