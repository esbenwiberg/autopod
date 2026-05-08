# Handover: awkward-shark (Brief 02 — Wake Reconciler + lastRecoveryTrigger)

## What was built

Extended the reconciler and pod-manager to recover pods cleanly from host sleep without penalising them for the involuntary interruption.

**Migration 096** (`packages/daemon/src/db/migrations/096_pod_last_recovery_trigger.sql`):
`ALTER TABLE pods ADD COLUMN last_recovery_trigger TEXT;`

**`Pod` type** (`packages/shared/src/types/pod.ts`):
Added `lastRecoveryTrigger: 'wake' | 'restart' | null` — a one-shot field set by the reconciler and consumed (then cleared) by `processPod()` at the validation entry.

**`pod-repository.ts`**: Plumbed `lastRecoveryTrigger` through `rowToPod`, `PodUpdates`, and the `UPDATE` setter block.

**`local-reconciler.ts`**:
- Added `ReconcileTrigger = 'restart' | 'wake'` type and optional `trigger?` field to `LocalReconcilerDependencies` (defaults to `'restart'` for backwards compat).
- `recoverSession()` now skips the `MAX_RECOVERIES` cap and `recoveryCount` increment when `trigger === 'wake'` (host sleep is not a repeating crash).
- Stamps `lastRecoveryTrigger: trigger` in the same `podRepo.update()` call that sets `recoveryWorktreePath`.

**`pod-manager.ts`**:
- Subscribes to `host.resumed` inside `startStuckPodWatchdog()`. Uses a bounded Set (`processedWakeTimestamps`, capped at 256, reset on overflow) keyed by event timestamp to prevent double-reconcile. Unsubscribe fn stored in `unsubscribeWakeRecovery` and cleaned up by `stopStuckPodWatchdog()`.
- After reconcile completes, re-publishes `host.resumed` with the **original timestamp** and `reconciledPodIds: result.recovered` so the desktop banner (brief 04) gets accurate counts.
- Validation entry point skips `validationAttempts` increment when `pod.lastRecoveryTrigger === 'wake'`; clears the flag in the same `podRepo.update()` call (one-shot, one DB write).
- Appends wake-correction postscript to the recovery task for non-Claude runtimes (`pod.runtime !== 'claude' && pod.lastRecoveryTrigger === 'wake'`). Claude runtimes recover via `--resume <session_id>` and don't need the hint.

## Interfaces / contracts changed

### `packages/shared/src/types/pod.ts`
```ts
lastRecoveryTrigger: 'wake' | 'restart' | null;  // added to Pod interface
```

### `packages/daemon/src/pods/pod-repository.ts`
```ts
lastRecoveryTrigger?: 'wake' | 'restart' | null;  // added to PodUpdates
```

### `packages/daemon/src/pods/local-reconciler.ts`
```ts
export type ReconcileTrigger = 'restart' | 'wake';
// Added to LocalReconcilerDependencies:
trigger?: ReconcileTrigger;  // defaults to 'restart'
```
Callers that don't pass `trigger` get the original restart behaviour unchanged.

### `packages/daemon/src/pods/pod-manager.ts`
- `startStuckPodWatchdog()` now also subscribes to `host.resumed` — downstream briefs (03, 04) must not break this subscription.
- `stopStuckPodWatchdog()` now also unsubscribes the wake-recovery listener.

## Files owned — do not modify without good reason

- `packages/daemon/src/pods/local-reconciler.ts` — the `ReconcileTrigger` type and trigger logic
- `packages/daemon/src/db/migrations/096_pod_last_recovery_trigger.sql` — never reuse migration number 096

## Discovered constraints / landmines

1. **Pre-submit review tool covers the full branch diff** (all commits since fork from main), not just this pod's commits. When running `pre_submit_review` on a series pod, the tool sees the parent pod's changes too and may flag them. The verdict can be a false negative. Verify by checking `linesAdded`/`linesRemoved` match your actual changes.

2. **Timestamp dedup, not `reconciledPodIds.length > 0`**. The naive de-dupe `if (reconciledPodIds.length > 0) return` would loop infinitely when 0 pods are recovered. The actual implementation uses the event `timestamp` as the dedup key (re-published event carries the original timestamp).

3. **`processedWakeTimestamps` Set lives in the closure** — resets if the daemon restarts, which is correct (each daemon lifecycle gets a fresh set). Don't move it outside `startStuckPodWatchdog`.

4. **Validation attempt skip is in `triggerValidation()`**, not in `processPod()` provisioning. The `lastRecoveryTrigger` field is still set when the runtime is spawned (provisioning path), so the postscript check at the spawn site is safe. The field is only cleared at the validation entry.

5. **Migration prefix verified at implementation time**: highest existing was 095, so 096 was correct. Next pod adding a migration should use 097+.
