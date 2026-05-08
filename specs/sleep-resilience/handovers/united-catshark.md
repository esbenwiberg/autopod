# Handover: united-catshark (Brief 01 — Sleep Detector)

## What was built

Added a host-sleep detector at `packages/daemon/src/pods/sleep-detector.ts` that publishes a `host.resumed` event on the `eventBus` whenever the daemon's event loop resumes after a long process suspension (laptop sleep).

Two layered detection mechanisms:
1. **Tick-gap heuristic** (primary, cross-platform): a `setInterval` at 30 s records `lastTickAt`; if the gap between ticks exceeds the threshold (default 180 s, env `AUTOPOD_SLEEP_DETECT_THRESHOLD_MS`), it publishes.
2. **macOS adjunct** (best-effort): tries `node-mac-power-monitor` (dynamic import, catches failure), then falls back to `pmset -g log` tail. The adjunct reads `lastTickAt` via a getter so it only fires when the threshold is also crossed — tick-gap remains the source of truth.

Dedupe: 5 s cooldown after publish. Disable: `AUTOPOD_DISABLE_SLEEP_DETECT=1`.

`HostResumedEvent` was added to the `SystemEvent` union in `@autopod/shared`. The detector is started at daemon boot after `startStuckPodWatchdog()`, and torn down in the graceful shutdown path.

## Interfaces / contracts changed

### `packages/shared/src/types/events.ts`
- Added `HostResumedEvent` interface (exported from `shared/src/index.ts`).
- Added `| HostResumedEvent` to the `SystemEvent` union.

**Any downstream code with exhaustive `switch (event.type)` over `SystemEvent` that lacks a `default` branch will now get a TS compile error.** Add a `case 'host.resumed':` branch (or a `default:`) to fix.

### `HostResumedEvent` shape (contract for brief 02 / 04)
```ts
{
  type: 'host.resumed';
  timestamp: string;         // ISO 8601
  sleptMs: number;           // wall-clock gap in ms
  detector: 'tick-gap' | 'pmset' | 'native';
  reconciledPodIds: string[]; // empty at emit; brief 02 populates after reconcile
}
```

Brief 02 must subscribe to `host.resumed` on the eventBus and, after reconciliation, either re-emit or update the event with `reconciledPodIds`.

## Files owned — do not modify without good reason

- `packages/daemon/src/pods/sleep-detector.ts` — brief 02/03 subscribe to its events, not its internals.
- `packages/shared/src/types/events.ts` — the `HostResumedEvent` definition and union position.

## Discovered constraints / landmines

1. **Dedupe test requires threshold override.** With the default 180 s threshold, `gap > threshold` always implies `now - lastPublishedAt > threshold >> 5 s dedupe window`, so dedupe suppression cannot be tested via tick-gap alone. Tests in `sleep-detector.test.ts` use `AUTOPOD_SLEEP_DETECT_THRESHOLD_MS=1` to decouple the two checks.

2. **Async adjunct race on early stop.** If `stopSleepDetector()` is called before `startMacOsAdjunct()` resolves, a `stopped` flag causes the adjunct to be torn down immediately when the promise settles. No leak.

3. **`node-mac-power-monitor` is entirely optional.** Dynamic import wrapped in `.catch(() => null)`. No post-install step; daemon starts fine on Linux/Windows without it.

4. **`setInterval` is `unref()`-ed** — won't prevent clean shutdown.

5. **pmset buffer is capped at 100 KB** — long-lived pmset process can't cause unbounded string growth.

6. **macOS adjunct starts asynchronously** — the stop function returned from `startSleepDetector` handles the race between teardown and adjunct startup via the `stopped` flag. Brief 02/03 should NOT depend on the adjunct being ready synchronously.

7. **pmset timestamp must be ISO 8601 normalised before passing to `Date`.** The string pmset emits (`2024-01-01 12:00:00 +0000`) is not parsed deterministically by V8's `Date(string)` — it returned NaN on some Node versions. `parsePmsetTimestamp` rewrites it to `2024-01-01T12:00:00+00:00` before construction. If you change that function, keep this normalisation.

8. **`_internals` export is for tests only.** `sleep-detector.ts` exports `_internals = { startMacOsAdjunct, startPmsetAdjunct, parsePmsetTimestamp }` so the macOS-only paths can be exercised from a Linux test runner. Brief 02/03 should not consume `_internals` — it is intentionally unstable.
