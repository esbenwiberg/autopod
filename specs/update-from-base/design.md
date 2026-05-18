# Design - Update From Base

## Blast Radius

### Daemon (`packages/daemon`)

- `src/pods/pod-manager.ts` - owns the operation, in-memory pending intent,
  validation abort handoff, rebase/revalidate flow, and force-with-lease publish
  allowance after a clean rebase.
- `src/pods/pod-manager.test.ts` - unit coverage for eligible statuses,
  validating abort, conflict, already-up-to-date, validation reset, and
  force-with-lease publish.
- `src/api/routes/pods.ts` - adds `POST /pods/:podId/update-from-base`.
- `src/api/routes/pods.test.ts` - route contract tests for all response variants.
- `src/interfaces/worktree-manager.ts` - uses the existing
  `rebaseOntoBase()` and `pushBranch(..., { force: true })` contracts. No new
  worktree method should be required.
- `src/test-utils/mock-helpers.ts` - ensure mocked worktree managers expose the
  existing rebase/push contract used by the new tests.

### Shared (`packages/shared`)

- `src/types/pod.ts` or a nearby shared route type file - exports the
  `UpdateFromBaseResponse` union for daemon, CLI, and desktop clients.
- `src/index.ts` - re-export if shared types require explicit exports.

### CLI (`packages/cli`)

- `src/api/client.ts` - adds `updateFromBase(id)`.
- `src/commands/pod.ts` - registers `ap update-from-base <id>`.
- `src/commands/pod.test.ts` or existing command tests - command coverage for
  success and conflict output.

### Desktop (`packages/desktop`)

- `Sources/AutopodClient/DaemonAPI.swift` - adds the response DTO and request.
- `Sources/AutopodDesktop/Stores/ActionHandler.swift` - adds the action wrapper
  and refresh/toast behaviour.
- `Sources/AutopodUI/Models/PodActions.swift` - exposes the action closure.
- `Sources/AutopodUI/Views/Detail/ValidationTab.swift` - adds the Validation
  tab button, disabled/loading states, and result messaging.
- `Sources/AutopodUI/Models/Pod.swift` and/or mock data only if required to
  expose `hasWorktree` / compromised-worktree flags already present on the wire.

## Seams

| Seam | Owner brief | Contract |
|------|-------------|----------|
| Route -> pod manager | 01 | `PodManager.updateFromBase(podId): Promise<UpdateFromBaseResponse>` |
| Pod manager -> worktree | 01 | Existing `WorktreeManager.rebaseOntoBase()` and `pushBranch(..., { force: true })` |
| Daemon -> clients | 01 | Shared `UpdateFromBaseResponse` union |
| CLI -> daemon | 02 | `AutopodClient.updateFromBase(id)` calls `POST /pods/:id/update-from-base` |
| Desktop -> daemon | 03 | `DaemonAPI.updateFromBase(podId:)` decodes the shared response shape |

## Contracts

### Response union

```ts
export type UpdateFromBaseResponse =
  | { ok: true; action: 'queued_after_abort' }
  | { ok: true; action: 'already_up_to_date'; baseBranch: string }
  | { ok: true; action: 'rebased'; baseBranch: string; validation: 'started' }
  | { ok: false; action: 'conflict'; baseBranch: string; conflicts: string[] };
```

`AutopodError` remains the mechanism for invalid state, missing pod, missing
worktree, missing branch, or compromised worktree errors.

### Eligible statuses

- `validating`
- `failed`
- `review_required`

All other statuses return a 409 `INVALID_STATE` error. A missing worktree is a
400 `INVALID_STATE` error. If the codebase already has a compromised-worktree
flag/check, the route must reuse it and refuse the action.

### Validating handoff

For a pod currently in `validating`:

1. Store a pending update intent in memory keyed by `podId`.
2. Abort the current validation with the existing validation
   `AbortController`.
3. Return `{ ok: true, action: 'queued_after_abort' }` immediately.
4. When the validation loop unwinds, check the pending intent before building
   correction feedback.
5. Run the same update-from-base flow used for parked pods.
6. If clean, reset validation attempts and start follow-up validation.
7. If conflicted, transition to `review_required` and emit an activity event
   with the conflicted files.

The pending intent is deliberately in-memory. A daemon restart during the abort
window loses the intent; the operator can click the action again.

### Failed / review_required flow

For parked pods:

1. Resolve the base branch using the same source as validation/merge paths.
2. Call `worktreeManager.rebaseOntoBase({ worktreePath, branch, baseBranch, ... })`.
3. If `alreadyUpToDate`, return `already_up_to_date` and do not revalidate.
4. If conflicts, return `ok: false, action: 'conflict'` with the conflicted
   paths and keep the pod reviewable (`failed` may remain failed;
   `review_required` remains review_required).
5. If rebased, mark the pod so the next branch publish may use
   `--force-with-lease`, reset validation attempts, transition to `validating`,
   start validation asynchronously, and return `rebased`.

### Publishing after rebase

Rebasing rewrites pod-branch history. After a clean update-from-base, the next
successful validation publish for that pod branch may use `pushBranch(...,
{ force: true })`, which maps to `--force-with-lease` in the existing local
worktree manager. Scope this allowance to the single pod branch and clear it
after a successful push or terminal failure.

Do not use force push for unrelated pod branches or for ordinary validation
pushes that did not follow update-from-base.

## UX Flows

### CLI

```
$ ap update-from-base abc12345
Updating pod abc12345 from base...
Rebased onto main. Validation restarted.

$ ap update-from-base abc12345
Pod abc12345 already contains latest main. No validation started.

$ ap update-from-base abc12345
Rebase conflict while updating from main:
  packages/foo/package.json
  pnpm-lock.yaml
```

Conflict exits with status 1. `queued_after_abort` prints that current
validation is stopping and the update will run next.

### Desktop Validation Tab

Approved v1 wireframe:

```
Validation tab header

Attempt 2 of 3                                      [Open App]
                                                    [Skip Validation]
                                                    [Update From Base]
                                                    [Interrupt]

For failed / review_required:

Attempt 3 of 3                                      [Update From Base]
                                                    [Force Approve]
```

Button visibility:

- Show only on the Validation tab.
- Show for `validating`, `failed`, and `review_required`.
- Disable when the pod has no worktree or a compromised worktree.
- While the request is in flight, show a spinner and disable the button.

Result handling:

- `queued_after_abort` - show a non-blocking message that validation is stopping
  and update-from-base will run next.
- `already_up_to_date` - show that the pod already contains the latest base.
- `rebased` - show that validation restarted.
- `conflict` - show conflicted files in the existing action feedback/toast
  surface; do not open a new screen in v1.

## Reference Reading

- `packages/daemon/src/pods/pod-manager.ts:1201` - existing validation
  `AbortController` map.
- `packages/daemon/src/pods/pod-manager.ts:6766` - current
  `triggerValidation()` path.
- `packages/daemon/src/pods/pod-manager.ts:7428` - validation-failure retry
  path where correction feedback is built; validating update intent must run
  before this branch sends feedback to the agent.
- `packages/daemon/src/pods/pod-manager.ts:7512` - existing
  `revalidateSession()` contract for failed/review_required pods.
- `packages/daemon/src/pods/pod-manager.ts:8540` - existing
  `interruptValidation()` behaviour.
- `packages/daemon/src/worktrees/local-worktree-manager.ts:973` - existing
  `rebaseOntoBase()` helper; fetches explicit `origin/<baseBranch>`, returns
  `alreadyUpToDate`, `rebased`, and `conflicts`, and aborts on conflicts.
- `packages/daemon/src/worktrees/local-worktree-manager.ts:937` - existing
  `pushBranch(..., { force: true })` support via `--force-with-lease`.
- `packages/shared/src/constants.ts:36` - current legal status transitions:
  `validating -> review_required`, `failed -> validating`, and
  `review_required -> validating` are already legal.
- `packages/daemon/src/api/routes/pods.ts:174` and nearby routes - route style
  for pod-scoped actions.
- `packages/cli/src/commands/pod.ts:38` - Commander pod command registration.
- `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift:212` -
  existing Validation-tab header action buttons.
- `docs/decisions/ADR-025-single-fix-pod-per-pr.md` - fix-pod ownership remains
  separate from this manual update action.
- `docs/decisions/ADR-007-local-recovery-requeue-not-resume.md` and
  `docs/decisions/ADR-008-local-recovery-kill-old-container-always.md` -
  precedent for using normal orchestration paths and fresh runtime state instead
  of bespoke resume complexity.

## Decisions

No new ADR is introduced. The durable decisions are intentionally small and
local to this spec:

- Manual-only action.
- No DB state or new pod status.
- Validation-tab-only desktop entrypoint in v1.
- Force-with-lease is allowed only for the next publish after a successful
  update-from-base rebase.
