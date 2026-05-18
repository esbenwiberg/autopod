# Handover — cheerful-shrew (brief 01: daemon update-from-base)

## What was built

Added `POST /pods/:podId/update-from-base` to the daemon. The route calls
`PodManager.updateFromBase(podId)` which:

- Validates the pod is in `validating`, `failed`, or `review_required` and has a
  worktree (otherwise throws `AutopodError` with `INVALID_STATE`).
- For **parked** (`failed` / `review_required`) pods: resolves the base branch,
  calls `worktreeManager.rebaseOntoBase(...)`, and returns one of the four typed
  `UpdateFromBaseResponse` variants directly.
- For **validating** pods: adds the pod ID to the in-memory
  `pendingUpdateFromBaseIntents` Set, aborts the active validation via
  `validationAbortControllers`, and immediately returns `{ ok: true, action:
  'queued_after_abort' }`. The validation unwind (retry path, max-attempts path,
  or outer catch) calls `tryConsumeUpdateIntent()` before sending correction
  feedback.
- After a clean rebase: adds the pod to `forceWithLeaseAllowances` so the next
  `pushBranch` call uses `--force-with-lease`; this allowance is cleared after
  the first push (in the no-change fast-path and in `approveSession`).

## Shared type added

`UpdateFromBaseResponse` is exported from `packages/shared/src/types/pod.ts` and
re-exported via `packages/shared/src/index.ts`. CLI (brief 02) and desktop
(brief 03) should import it from `@autopod/shared`.

```ts
export type UpdateFromBaseResponse =
  | { ok: true; action: 'queued_after_abort' }
  | { ok: true; action: 'already_up_to_date'; baseBranch: string }
  | { ok: true; action: 'rebased'; baseBranch: string; validation: 'started' }
  | { ok: false; action: 'conflict'; baseBranch: string; conflicts: string[] };
```

## Route shape

```
POST /pods/:podId/update-from-base
→ 200  { ok: true, action: 'queued_after_abort' }
→ 200  { ok: true, action: 'already_up_to_date', baseBranch }
→ 200  { ok: true, action: 'rebased', baseBranch, validation: 'started' }
→ 409  { ok: false, action: 'conflict', baseBranch, conflicts: string[] }
→ 409  { error: string, code: 'INVALID_STATE' }   (wrong status or compromised worktree)
→ 400  { error: string, code: 'INVALID_STATE' }   (no worktree)
```

The conflict outcome uses 409 (not 422) — brief 02 and 03 should handle this.

## Files owned (do not modify without reason)

- `packages/daemon/src/pods/pod-manager.ts` — all new state and logic lives here
- `packages/daemon/src/api/routes/pods.ts` — route registration
- `packages/shared/src/types/pod.ts` — `UpdateFromBaseResponse` type
- `packages/shared/src/index.ts` — re-export of the type

## Landmines / constraints

- `pendingUpdateFromBaseIntents` and `forceWithLeaseAllowances` are **in-memory
  Sets** captured by the `createPodManager` factory closure. They survive for the
  lifetime of the process but are cleared on delete (`deleteSession` cleans both).
  A daemon restart between intent-set and unwind silently loses the intent — this
  is by design (spec non-goal).

- The intent check (`tryConsumeUpdateIntent()`) is called in **three locations**
  inside `triggerValidation`: the retry path, the max-attempts path, and the outer
  catch block. All three are reachable. Removing any one of them would create a
  window where the intent is consumed but the rebase is never run.

- `forceWithLeaseAllowances` is consumed by two push sites: the no-change
  fast-path in `handleCompletion` (~line 5902) and the pre-merge push in
  `approveSession` (~line 5974). Both sites check `.has()` then `.delete()` before
  deciding whether to pass `{ force: true }`. Only one of these paths runs for any
  given pod completion — the allowance is scoped to a single push.

- `failed → review_required` is **not a valid transition**. After an abort, the
  inner helper `runUpdateFromBaseAfterAbort` transitions the pod from `validating`
  (which can go to `review_required`) to either `failed` (clean rebase) or
  `review_required` (conflict). The outer `transition(s2, 'failed')` in the catch
  block is guarded by `tryConsumeUpdateIntent()` returning early.

## Deviations from brief

None. The implementation matches the spec contracts exactly.
