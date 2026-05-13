# Handover: distant-buzzard (Brief 01 — Schema + Shared Types)

## What was built

**Migration `099_single_fix_pod.sql`** creates the `pending_fix_feedback` table
(with composite index on `pod_id, created_at`) and drops the deprecated
`reuse_fix_pod` and `fix_pod_cooldown_sec` columns from `profiles`.

**`FixFeedbackRepository`** (`packages/daemon/src/pods/fix-feedback-repository.ts`)
implements the full `enqueue / peek / drain / count` interface against the new
table. `drain` uses a single SQLite transaction (delete-after-running contract).
Full unit test coverage in `fix-feedback-repository.test.ts`.

**Shared types** (`packages/shared`):
- `FixFeedback` and `SpawnFixResponse` added to `src/types/pod.ts` and exported from `src/index.ts`
- `Pod` interface gains `queueLength?: number`
- `Profile` interface and Zod schema (`profile.schema.ts`) no longer have `reuseFixPod` or `fixPodCooldownSec`
- `DEFAULT_MAX_PR_FIX_ATTEMPTS` bumped 2 → 5

**Migration runner** (`packages/daemon/src/db/migrate.ts`) extended from a single
`CUTOVER_MIGRATION_VERSION = 91` constant to a `CUTOVER_MIGRATIONS` map
(`{91: 'pre-screenshot-cutover', 99: 'pre-single-fix-pod'}`), so both migrations
now snapshot the DB before applying.

**Column-drop followthrough**: profile-store.ts, profile-store.test.ts,
profile-validator.ts, profile-validator.test.ts, pod-manager.test.ts, and
pod-repository.ts were updated to remove all references to the dropped columns.
The entire `reuseFixPod=true` test describe block was removed from
pod-manager.test.ts (362 lines); brief 02 will write new tests for the new
single-fix-pod behavior.

All 143 test files pass (2579 tests). Both ACs verified green.

## Interfaces / contracts downstream pods must know about

### `FixFeedbackRepository` (daemon-internal)
File: `packages/daemon/src/pods/fix-feedback-repository.ts`

```ts
export interface FixFeedbackRepository {
  enqueue(podId: string, message: string): FixFeedback;
  peek(podId: string): FixFeedback[];
  drain(podId: string): FixFeedback[];   // transactional read+delete
  count(podId: string): number;
}
export function createFixFeedbackRepository(db: Database): FixFeedbackRepository
```

`podId` is the **parent pod** ID (not the fix pod). Call `drain` only when the
consuming fix-pod iteration transitions to `running` — that's the delete-after-running guarantee.

### `SpawnFixResponse` (HTTP contract, owned by brief 03)
Exported from `@autopod/shared`:
```ts
type SpawnFixResponse =
  | { ok: true; queued: boolean; queueLength: number; fixPodId: string | null }
  | { ok: false; reason: 'parent_terminal' };
```

### `Pod.queueLength` (wire serialisation)
`Pod` now has `queueLength?: number`. Brief 02 must populate it from
`fixFeedbackRepo.count(pod.id)` in the pod serialiser.

## Files this pod owns — downstream pods must not modify without good reason

- `packages/daemon/src/db/migrations/099_single_fix_pod.sql` — never modify an applied migration
- `packages/daemon/src/db/migrate.ts` — the CUTOVER_MIGRATIONS map; safe to extend with new entries
- `packages/daemon/src/pods/fix-feedback-repository.ts` — brief 02 is the consumer
- `packages/daemon/src/pods/fix-feedback-repository.test.ts` — brief 02 may add tests here

## Constraints and landmines for downstream pods

1. **`pod-manager.ts` still reads `profile.reuseFixPod` and `profile.fixPodCooldownSec`**.
   These fields are gone from the type and DB — at runtime they will be `undefined`.
   Accessing `profile.reuseFixPod !== true` evaluates to `true` (the "don't reuse" path),
   so the old `reuseFixPod` code paths in `pod-manager.ts` still *run* but take the
   legacy branch every time. Brief 02 must remove this dead code.

2. **TypeScript does NOT catch `profile.reuseFixPod` as an error** because tsup's
   esbuild transpilation doesn't type-check; only the DTS emit does, and it only covers
   exported surface. Brief 02 will see the type error when doing a strict `tsc --noEmit`.

3. **`pod-manager.ts` `extendPrAttempts`** still checks `profile.reuseFixPod !== true`
   to decide whether to clear `fixPodId`. With the field gone this will always clear
   `fixPodId`. Brief 02 needs to fix the `extendPrAttempts` semantics for the new design.

4. **`DEFAULT_MAX_PR_FIX_ATTEMPTS` is now 5** (was 2). Tests that assert on
   `maxPrFixAttempts` default values need to be updated if they hardcode `2`.
