---
title: "Add daemon update-from-base action"
depends_on: []
acceptance_criteria:
  - type: cmd
    outcome: npx pnpm --filter @autopod/daemon test -- pod-manager update-from-base -> exit 0
    hint: npx pnpm --filter @autopod/daemon test -- pod-manager update-from-base
    polarity: exit-zero
  - type: cmd
    outcome: npx pnpm --filter @autopod/daemon test -- routes update-from-base -> exit 0
    hint: npx pnpm --filter @autopod/daemon test -- routes update-from-base
    polarity: exit-zero
touches:
  - packages/shared/src/types/pod.ts
  - packages/shared/src/index.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/test-utils/mock-helpers.ts
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/pod-repository.ts
  - packages/cli/
  - packages/desktop/
  - packages/escalation-mcp/
---

## Task

Add the daemon-owned `update-from-base` operation and expose it through
`POST /pods/:podId/update-from-base`.

The operation is manual-only. It rebases an eligible pod branch onto the latest
base branch and starts validation again when the rebase is clean. It does not
create a new pod status, does not write a new DB column, and does not use
`mergeBlockReason`.

### Shared response type

Export this union from shared types:

```ts
export type UpdateFromBaseResponse =
  | { ok: true; action: 'queued_after_abort' }
  | { ok: true; action: 'already_up_to_date'; baseBranch: string }
  | { ok: true; action: 'rebased'; baseBranch: string; validation: 'started' }
  | { ok: false; action: 'conflict'; baseBranch: string; conflicts: string[] };
```

Use this exact shape in daemon, CLI, and desktop clients.

### PodManager API

Add `updateFromBase(podId: string): Promise<UpdateFromBaseResponse>` to the
`PodManager` interface and implementation.

Eligibility:

- Allowed statuses: `validating`, `failed`, `review_required`.
- Missing pod: existing not-found behaviour.
- Any other status: `AutopodError(..., 'INVALID_STATE', 409)`.
- Missing worktree: `AutopodError(..., 'INVALID_STATE', 400)`.
- Compromised worktree: if the daemon already exposes a worktree-compromise
  guard, reuse it and reject with `INVALID_STATE`.

### Parked pods

For `failed` and `review_required` pods:

1. Resolve the same base branch the existing validation/merge paths use.
2. Call `worktreeManager.rebaseOntoBase(...)`.
3. If `alreadyUpToDate`, return:
   `{ ok: true, action: 'already_up_to_date', baseBranch }`
   and do not start validation.
4. If conflicts are returned, return:
   `{ ok: false, action: 'conflict', baseBranch, conflicts }`.
   Keep `review_required` pods in `review_required`; a failed pod may remain
   `failed`.
5. If cleanly rebased, reset validation attempt counters/visible rework state
   so the follow-up validation starts as attempt 1.
6. Transition to `validating`, start validation asynchronously, and return:
   `{ ok: true, action: 'rebased', baseBranch, validation: 'started' }`.

Do not block the HTTP request on final pass/fail. The user sees final status
through existing pod events/status updates.

### Currently validating pods

For `validating` pods:

1. Store an in-memory pending update intent keyed by `podId`.
2. Abort the existing validation via the current validation
   `AbortController`.
3. Return `{ ok: true, action: 'queued_after_abort' }` immediately.
4. In the validation failure/unwind path, check and consume the pending intent
   before building correction feedback or transitioning back to `running`.
5. Run the same rebase decision used for parked pods.
6. If conflicts happen after abort, transition the pod to `review_required`
   (already legal by `VALID_STATUS_TRANSITIONS`) and emit an activity status
   containing the conflicted files.
7. If clean, reset validation attempts and start follow-up validation as
   attempt 1.

The pending map is intentionally not persisted. If the daemon restarts during
the abort window, the operator can run the action again.

### Publishing after rebase

A successful update-from-base rebase rewrites local branch history. Mark the pod
so the next successful validation publish may call
`worktreeManager.pushBranch(worktreePath, branch, { force: true })`, which the
local manager implements as `--force-with-lease`.

Scope this allowance to the single pod branch and clear it after one successful
push or terminal failure. Do not use force push for ordinary validation runs.

## Touches

- `packages/shared/src/types/pod.ts` - add/export `UpdateFromBaseResponse`
  unless a more appropriate shared response-types file already exists.
- `packages/shared/src/index.ts` - re-export the response type if needed.
- `packages/daemon/src/pods/pod-manager.ts` - add manager method, pending intent
  map, abort handoff, rebase flow, validation reset, and scoped force-with-lease
  marker.
- `packages/daemon/src/pods/pod-manager.test.ts` - daemon behaviour tests.
- `packages/daemon/src/api/routes/pods.ts` - add route.
- `packages/daemon/src/api/routes/pods.test.ts` - route response tests.
- `packages/daemon/src/test-utils/mock-helpers.ts` - keep mock worktree manager
  aligned with the existing rebase/push contract.

## Does not touch

- No migrations or pod repository schema changes.
- No CLI or desktop changes in this brief.
- No fix-pod / `merge_pending` flow changes.
- No `mergeBlockReason` writes.

## Constraints

- Reuse `worktreeManager.rebaseOntoBase()`; do not implement ad-hoc git rebase
  logic in `pod-manager.ts`.
- Reuse the existing validation abort mechanism.
- Use existing event/status emission patterns so desktop and CLI watch flows
  update naturally.
- Route must be fire-and-forget for validation completion. Final pass/fail is
  not part of the HTTP response.
- Keep all new state in memory unless an existing pod field already perfectly
  fits. Do not add a migration.

## Test Expectations

Add focused daemon tests that cover:

- `failed` + clean rebase returns `rebased` and starts validation.
- `review_required` + clean rebase returns `rebased` and starts validation.
- `validating` returns `queued_after_abort`, aborts validation, and the unwind
  runs update-from-base before correction feedback is sent to the agent.
- `alreadyUpToDate` returns `already_up_to_date` and does not start validation.
- conflicts return `{ ok: false, action: 'conflict' }` with file paths and do
  not write `mergeBlockReason`.
- conflict after abort transitions `validating` to `review_required`.
- clean rebase resets validation attempts to attempt 1.
- the next publish after clean rebase uses `{ force: true }`, then clears the
  force allowance.
- invalid statuses return 409.
- missing worktree returns 400.

## Wrap-up

- Run the targeted daemon tests named in the acceptance criteria.
- Include the response union and status/attempt semantics in the handover.
- Call out any existing worktree-compromise signal that was reused or found
  absent.
