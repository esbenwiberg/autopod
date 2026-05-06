# Handover — growing-heron (Brief 02-prune: Screenshot retention sweeper)

## What was built

A periodic retention sweeper that deletes on-disk screenshot directories for pods in terminal
states past the configured retention period. Key deliverables:

1. **`packages/daemon/src/pods/screenshot-retention.ts`** — `ScreenshotRetention` class with:
   - `start()` — runs `sweepOnce()` immediately, then every `sweepIntervalMs` via `setInterval`.
     Idempotent: calling twice is a no-op (second call returns immediately, no timer stacking).
   - `stop()` — idempotent `clearInterval`. Safe to call even if never started.
   - `sweepOnce()` — public, returns `{ scanned, deleted }`. Computes cutoff as
     `Date.now() - retentionDays * 24 * 60 * 60 * 1000`. Uses boundary-inclusive `<=` so a pod
     completed exactly `retentionDays` ago IS swept. Delete failures are caught and logged per-pod
     (never abort the sweep).
   - `runSweep()` — private guard: prevents concurrent overlapping sweeps when interval fires
     while disk I/O is still in-flight.

2. **`packages/daemon/src/pods/pod-repository.ts`** — Added `listTerminalPodsCompletedBefore(cutoffIso)`:
   - Interface and implementation updated.
   - Queries `status IN ('complete', 'killed', 'failed') AND completed_at IS NOT NULL AND completed_at <= cutoffIso`.
   - Returns full `Pod[]` via the existing `rowToSession` mapper.
   - `'failed'` is explicitly included — `isTerminalState()` in state-machine.ts only covers
     `complete | killed`, but the brief and the spec explicitly require `failed` pods to be swept.
     See the constraint note below.

3. **`packages/daemon/src/pods/screenshot-retention.test.ts`** — 13 tests:
   All 8 spec-required cases: empty cohort, fresh pod, stale pod, mixed cohort, idempotency,
   delete-failure isolation, boundary-inclusive day, workspace pods. Plus: failed pods test and
   two timer smoke tests (stop cancels, start is idempotent).

4. **`packages/daemon/src/index.ts`** — Wired in:
   - `AUTOPOD_SCREENSHOT_RETENTION_DAYS` env var read with validation (throws on non-positive).
   - `ScreenshotRetention` instantiated with `podRepo`, `screenshotStore`, `retentionDays`,
     `sweepIntervalMs: 60 * 60 * 1000` (1 hour hard-coded).
   - `screenshotRetention.start()` called after server starts listening.
   - `screenshotRetention.stop()` wired into the graceful-shutdown handler alongside other workers.

## Deviations from the brief

- **`failed` vs `isTerminalState`**: The brief says to use `isTerminalState` from `state-machine.ts`
  if exported, but that function only includes `complete | killed` (NOT `failed`). The spec explicitly
  lists `failed` as terminal for retention purposes. Resolution: `listTerminalPodsCompletedBefore`
  queries all three states directly in SQL. The sweeper does not call `isTerminalState()`.
- No other meaningful deviations.

## Contracts downstream pods must honour

### `PodRepository.listTerminalPodsCompletedBefore` (new method)

```ts
listTerminalPodsCompletedBefore(cutoffIso: string): Pod[];
```

Returns pods in `complete | killed | failed` states with `completed_at <= cutoffIso`. The `failed`
status inclusion was intentional per the spec's Glossary definition of "terminal state". Do not
remove `failed` from the query without coordinating with the spec owners.

### `ScreenshotRetention` public API (stable for index.ts consumers)

```ts
new ScreenshotRetention(opts: ScreenshotRetentionOptions)
retention.start(): void
retention.stop(): void
retention.sweepOnce(): Promise<{ scanned: number; deleted: number }>
```

`sweepOnce()` is public intentionally — for testing and for any future health-check endpoint that
wants to trigger a manual sweep. It is NOT guarded by the double-fire guard (`runSweep()` is the
guard — `sweepOnce()` is the raw implementation).

## Files owned — do not modify without good reason

- `packages/daemon/src/pods/screenshot-retention.ts` — the sweeper; interface is stable
- `packages/daemon/src/pods/pod-repository.ts` — added `listTerminalPodsCompletedBefore`; do not
  remove `failed` from the SQL without coordinating with the retention sweeper

## Discovered constraints / landmines

- **`isTerminalState()` does NOT include `failed`**: The code in `state-machine.ts` returns `true`
  only for `complete | killed`. The daemon CLAUDE.md docs say it includes `failed` — this is stale
  documentation. The query in `listTerminalPodsCompletedBefore` correctly includes `failed`.
  If a future pod changes `isTerminalState` to include `failed`, confirm the tests at
  `state-machine.test.ts:99` (`expect(isTerminalState('failed')).toBe(false)`) are updated too.

- **`completed_at` IS set for `failed` pods**: Verified in pod-manager.ts — all three terminal
  transition sites (`complete`, `killed`, `failed`) call `transition(pod, status, { completedAt: new Date().toISOString() })`.
  No fallback to `created_at` is needed.

- **Sweeper start timing**: `screenshotRetention.start()` is called immediately after the server
  starts listening (line ~686 in index.ts). The first sweep fires immediately on boot. For a daemon
  that has been running for months, this means a potentially large first sweep. This is intentional
  per the spec ("that's the point").

- **`sweepOnce()` is not concurrency-safe with itself**: If two callers call `sweepOnce()` directly
  at the same time, both sweeps run in parallel (the `runSweep()` guard only prevents interval
  double-fire). This is acceptable since `screenshotStore.delete()` is idempotent, and the only
  production caller is the periodic timer via `runSweep()`.
