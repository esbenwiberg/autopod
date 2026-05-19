---
title: "Add daemon update-from-base action"
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

For parked `failed` and `review_required` pods, resolve the pod's base branch,
call the existing `worktreeManager.rebaseOntoBase(...)`, and return one of the
typed outcomes from `design.md` -> Contracts. `alreadyUpToDate` should return
without starting validation. Conflicts should return the conflict response and
leave the pod reviewable. A clean rebase should reset validation attempt state,
transition to `validating`, start validation asynchronously, and return
`rebased`.

For `validating` pods, store an in-memory pending update intent, abort the
current validation through the existing validation `AbortController`, and return
`queued_after_abort` immediately. When the validation loop unwinds, consume that
pending intent before building correction feedback or resuming the agent. If the
rebase conflicts after abort, transition to `review_required`; if it succeeds,
reset attempts and start follow-up validation as attempt 1.

A successful update-from-base rebase rewrites local branch history. Mark only
that pod branch so the next successful validation publish may call
`worktreeManager.pushBranch(worktreePath, branch, { force: true })`, then clear
the allowance after one successful push or terminal failure.

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

- `packages/daemon/src/db/migrations/` - no schema or DB state.
- `packages/daemon/src/pods/pod-repository.ts` - do not add persisted fields.
- `packages/cli/` - CLI work belongs to brief 02.
- `packages/desktop/` - desktop work belongs to brief 03.
- `packages/escalation-mcp/` - no agent/MCP prompt path for this action.

## Constraints

- Follow `design.md` -> Contracts for the exact `UpdateFromBaseResponse` union.
- Reuse `worktreeManager.rebaseOntoBase()`; do not implement ad-hoc git rebase
  logic in `pod-manager.ts`.
- Reuse the existing validation abort mechanism and status transitions from
  `packages/shared/src/constants.ts`.
- Route must be fire-and-forget for validation completion. Final pass/fail is
  not part of the HTTP response.
- Keep all new operational state in memory unless an existing pod field already
  perfectly fits. Do not add a migration.

## Test expectations

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

## Risks / pitfalls

- The validation failure retry branch currently builds correction feedback and
  resumes the agent. The pending update intent must be checked before that path.
- Force-with-lease must be scoped to the rebased pod branch only.
- The pending intent is in-memory by design; daemon restart during the abort
  window should not leave durable partial state.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
