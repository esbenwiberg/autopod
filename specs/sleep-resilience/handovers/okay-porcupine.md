# Handover: okay-porcupine (Brief 03 — Wake Grace Window)

## What was built

Added a 60 s grace window after every `host.resumed` event so the stuck-pod
watchdog and the idle liveness probe don't race the reconciler and force-fail
pods that are about to be cleanly recovered.

**Stuck-pod watchdog grace (`pod-manager.ts:startStuckPodWatchdog`):**
- Added `WAKE_GRACE_MS = 60_000` and `lastWakeAt: number | null = null` inside
  the watchdog closure.
- At the top of `tick()`: if `Date.now() - lastWakeAt < WAKE_GRACE_MS`, the
  entire tick is skipped (debug-logged).
- `lastWakeAt = Date.now()` is updated **before** the dedupe check in the
  existing `host.resumed` subscriber so every emit (including the re-published
  completed event from brief 02) refreshes the window.

**Idle liveness probe wake signal (`stream-grace.ts:withIdleLivenessProbe`):**
- Added optional `wakeSignal?: () => Promise<void>` to `IdleLivenessProbeOptions`.
- Each loop iteration calls `wakeSignal()` fresh (re-arms after every wake).
- Added `{ kind: 'wake' }` branch to the `Promise.race`; on win, `continue`
  (resets idle timer, keeps `pendingNext` alive — no double-call to `iterator.next()`).
- Callers that don't pass `wakeSignal` are entirely unaffected.

## Interfaces / contracts changed

### `IdleLivenessProbeOptions` (stream-grace.ts)
Added:
```ts
wakeSignal?: () => Promise<void>;
```
Existing callers (`claude-runtime.ts`, `codex-runtime.ts`, `copilot-runtime.ts`)
do not pass it and continue working exactly as before. The field is purely additive.

### `pod-manager.ts` watchdog closure
`lastWakeAt` and `WAKE_GRACE_MS` are private to the closure; no exported interface
changed.

## Files owned — do not modify without good reason

- `packages/daemon/src/runtimes/stream-grace.ts` — the wakeSignal option and
  'wake' branch in the Promise.race are tightly coupled to the invariant that
  `pendingNext` must not be cleared on a wake iteration.
- `packages/daemon/src/pods/pod-manager.ts` — the `lastWakeAt` update MUST
  happen before the `processedWakeTimestamps.has()` dedupe check, or the
  re-published completed event won't refresh the grace window.

## Discovered constraints / landmines

1. **Reconciler kills pods when worktreePath doesn't exist.** When
   `host.resumed` fires, `reconcileLocalSessions` runs async and kills any
   'local' pod whose worktree path doesn't exist on disk. This made watchdog
   grace tests tricky: tests use `ctx.db.prepare('UPDATE pods SET
   execution_target = ? WHERE id = ?').run('aci', pod.id)` to exempt test pods
   from the reconciler (which only reconciles 'local' pods). Brief 04 should be
   aware of this if it adds tests that combine wake events with running pods.

2. **wakeSignal not wired into runtime callsites yet.** The capability exists in
   `withIdleLivenessProbe` but none of the runtime files (`claude-runtime.ts`,
   `codex-runtime.ts`, `copilot-runtime.ts`) pass a `wakeSignal`. Brief 04
   (desktop banner) doesn't need it, but a future brief could wire it by adding
   `wakeSignal` to `SpawnConfig`/`ResumeOptions` in `shared/src/types/runtime.ts`
   and threading it through the runtimes.

3. **`WAKE_GRACE_MS` is defined inside the watchdog closure**, not at module
   scope. This keeps it private but means tests can't import it directly. Tests
   verify the 60 s boundary by timing (fake timers), not by reading the constant.

4. **Grace window refreshes on EVERY `host.resumed`**, including the
   re-published event (brief 02 emits it with `reconciledPodIds` populated).
   This is intentional (both `detector` + `completed` events count as activity),
   but means the effective grace window can extend slightly beyond 60 s from the
   original sleep detection if the reconcile takes non-zero time.
