---
title: "Add sleep-detector module + HostResumedEvent type"
acceptance_criteria: []
touches:
  - packages/shared/src/types/events.ts
  - packages/shared/src/index.ts
  - packages/daemon/src/pods/sleep-detector.ts
  - packages/daemon/src/pods/sleep-detector.test.ts
  - packages/daemon/src/index.ts
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/local-reconciler.ts
  - packages/daemon/src/runtimes/stream-grace.ts
---

## Task

Add a host-sleep detector that publishes a `host.resumed` event over the
`eventBus` when the daemon's event loop resumes after a long process
suspension (laptop sleep being the primary cause).

Two detection mechanisms, layered:

1. **Tick-gap heuristic (primary, cross-platform).** A `setInterval`
   callback running every 30 s records `lastTickAt = Date.now()` at the
   end of each tick. At the start of each tick, compute
   `gap = Date.now() - lastTickAt`. If `gap > AUTOPOD_SLEEP_DETECT_THRESHOLD_MS`
   (default 180 000), publish a `HostResumedEvent` with `sleptMs = gap`
   and `detector = 'tick-gap'`.

2. **macOS power-notification adjunct.** When `process.platform === 'darwin'`,
   try to load an optional native module (e.g. `node-mac-power-monitor`)
   inside a try/catch. If it loads, subscribe to its wake event. If it
   fails to load, fall back to a child-process tail of `pmset -g log`
   parsing for `Wake from` lines. On a wake notification, compute
   `sleptMs` from the kernel-reported sleep timestamp if available, or
   from the same `lastTickAt` snapshot the tick-gap path uses. Publish
   with `detector = 'native'` (module loaded) or `'pmset'` (log fallback).

   The adjunct is lossy and best-effort — its job is precision, not
   correctness. The tick-gap heuristic is the source of truth.

**Dedupe.** After publishing a `host.resumed` event from either source,
ignore further wake signals for 5 s (in-memory cooldown). The first
detector wins.

**Disable.** When `process.env.AUTOPOD_DISABLE_SLEEP_DETECT === '1'`,
`startSleepDetector()` is a no-op (returns immediately, no interval set).

The `HostResumedEvent` shape (in `packages/shared/src/types/events.ts`):

```ts
export interface HostResumedEvent {
  type: 'host.resumed';
  timestamp: string;
  sleptMs: number;
  detector: 'tick-gap' | 'pmset' | 'native';
  reconciledPodIds: string[]; // empty at initial emit; pod-manager
                              // populates this AFTER reconcile (brief 02)
}
```

Add `HostResumedEvent` to the `SystemEvent` union in the same file. The
union must remain exhaustive — TypeScript will fail builds elsewhere if
we miss a switch.

In `packages/daemon/src/index.ts`, call `startSleepDetector(eventBus, logger)`
after the existing daemon setup, alongside the existing
`startStuckPodWatchdog()` call.

## Touches

- `packages/shared/src/types/events.ts` — define and export
  `HostResumedEvent`; add to `SystemEvent` union.
- `packages/shared/src/index.ts` — re-export if not auto.
- `packages/daemon/src/pods/sleep-detector.ts` — new module exposing
  `startSleepDetector(eventBus, logger): () => void` (returns a stop
  function for tests + clean shutdown).
- `packages/daemon/src/pods/sleep-detector.test.ts` — unit tests using
  `vitest` fake timers and a mock event bus.
- `packages/daemon/src/index.ts` — start the detector at boot.

## Does not touch

- `packages/daemon/src/pods/pod-manager.ts` — subscriber lives in
  brief 02.
- `packages/daemon/src/pods/local-reconciler.ts` — wake-trigger lives
  in brief 02.
- `packages/daemon/src/runtimes/stream-grace.ts` — wake-aware idle
  probe lives in brief 03.

## Constraints

- The detector MUST NOT crash on Linux or Windows daemons. Tick-gap
  works everywhere; the macOS adjunct is wrapped in
  `if (process.platform === 'darwin')` plus a try/catch.
- The optional native module dependency MUST be optional: import via
  `await import('node-mac-power-monitor').catch(() => null)` (or
  equivalent dynamic require). No post-install build step may be
  required for the daemon to start on a non-darwin host.
- Threshold env var follows the existing pattern of
  `AUTOPOD_STUCK_RUNNING_THRESHOLD_MS` (`pod-manager.ts:8276`):
  `Number(process.env.AUTOPOD_SLEEP_DETECT_THRESHOLD_MS)` with a
  hard-coded default of `180_000`.
- Tick interval is hard-coded at 30 s. (Watchdog is at 60 s; we need
  to be faster to fire wake-recovery first. See `design.md` → Race
  conditions.)
- `setInterval` handle MUST be `unref()`-ed so it doesn't keep the
  event loop alive on shutdown (mirrors `pod-manager.ts:8273`
  watchdog).

## Test expectations

In `sleep-detector.test.ts`:

**Happy path — tick-gap detection:**
- Start detector with mock event bus and fake timers.
- Advance fake time by 30 s; tick fires; gap = 30 s; no event published.
- Advance fake time by 4 h (simulating sleep); tick fires; gap = 4 h
  + 30 s; event published with `sleptMs ≈ 4h+30s`, `detector: 'tick-gap'`.

**Threshold:**
- Threshold default 180 000 ms; gap of 90 s → no event; gap of 200 s →
  event.
- Override via `AUTOPOD_SLEEP_DETECT_THRESHOLD_MS=60000`; gap of 90 s →
  event.

**Disable:**
- `AUTOPOD_DISABLE_SLEEP_DETECT=1` → `startSleepDetector()` returns
  no-op stop function; no setInterval registered; no events on any
  fake-time advance.

**Dedupe:**
- Tick-gap fires; macOS adjunct also fires within 5 s for the same
  sleep → only one event published.
- Tick-gap fires; macOS adjunct fires 10 s later → both published
  (separate events; cooldown elapsed).
- macOS adjunct fires alone (no tick-gap, e.g. very brief sleep that
  somehow notifies but didn't cross threshold) → not published. The
  tick-gap is source of truth; if threshold isn't crossed, no event.

  *Implementation detail for the executor:* the cleanest way to enforce
  this is to have the macOS adjunct *also* read `lastTickAt` and
  publish only when the threshold is crossed.

**Platform:**
- `process.platform === 'linux'` → no macOS adjunct registered; tick-gap
  alone works.
- `process.platform === 'darwin'` + native module load fails → falls
  back to `pmset` tail; if that also fails, tick-gap alone (logged at
  `warn` level once).

**Cleanup:**
- `stopFn()` returned from `startSleepDetector()` clears the interval
  and tears down any macOS adjunct subscription.

## Risks / pitfalls

- `vitest` fake timers and `setInterval` interact in subtle ways —
  prefer `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(ms)` over
  `vi.runAllTimers()`.
- Don't accidentally use `setInterval` from `node:timers/promises` —
  the existing watchdog in `pod-manager.ts:8273` uses the global
  `setInterval` and `unref()`. Match that.
- The `node-mac-power-monitor` package, if used, may require a native
  build. The dynamic-import-with-catch pattern keeps it truly optional.
  If you can't make this clean, prefer the `pmset -g log` tail —
  spawning a long-lived child process is acceptable here (tear it down
  in the stop function).

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
