---
title: "Gate approval and automation on Readiness Review"
touches:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/shared/src/types/events.ts
does_not_touch:
  - packages/desktop/
  - packages/cli/
  - packages/daemon/src/worktrees/pr-body-builder.ts
---

## Task

Make daemon approval consume Readiness Review.

Extend `approveSession(...)` and the approve route with optional approval
metadata:

```ts
{ squash?: boolean; reason?: string }
```

Before approving, recompute Readiness. If advisory QA is enabled and already in
flight, wait for it to finish, persist its result through the existing advisory
history path, recompute Readiness, then decide.

Manual rules:

- `ready` can approve without a reason.
- `needs_review` can approve without a reason, but Desktop will route the human
  through the Readiness tab in Brief 05.
- `risky` and `waived` require a non-empty reason.

Automation rules:

- `autoApprove` approves only `ready`.
- approve-all approves only `ready` and reports skipped pods.
- single-PR final/PR-owning approval uses Series Readiness, not only final-pod
  Readiness.

## Touches

- `packages/daemon/src/pods/pod-manager.ts` - enforce the approval contract,
  store approval metadata in the snapshot, emit a readiness approval event, and
  adjust auto-approval call sites.
- `packages/daemon/src/pods/pod-manager.test.ts` - manual, automatic,
  advisory-wait, and single-PR approval behavior.
- `packages/daemon/src/api/routes/pods.ts` - accept `reason` on approve and
  return skipped pods from approve-all.
- `packages/daemon/src/api/routes/pods.test.ts` - route validation and
  approve-all response coverage.
- `packages/shared/src/types/events.ts` - add a readiness approval event type if
  event typing requires it.

## Does Not Touch

Do not change PR body generation in v1. Do not make readiness a scheduler brake.
Do not require reasons for `needs_review`. Do not make advisory QA a validation
gate.

## Constraints

- Approval reason is required for `risky` and `waived`; whitespace-only reasons
  are invalid.
- Store approval metadata inside the latest readiness snapshot, including
  `approvedAt`, `statusAtApproval`, `scope`, optional `seriesId`, and `reason`
  when supplied.
- Emit a pod event such as `pod.readiness_approved` after successful approval
  for `needs_review`, `risky`, or `waived`; include status, scope, summary, and
  reason when supplied.
- Existing direct approval of `ready` pods should stay low-friction.
- Approve-all response should be additive, for example:

  ```ts
  {
    approved: string[];
    skipped: Array<{ podId: string; status: ReadinessStatus; reason: string }>;
  }
  ```

- Existing clients that only read `approved` should not break if possible.

## Test Expectations

- Manual `ready` approval succeeds without a reason.
- Manual `needs_review` approval succeeds without a reason.
- Manual `risky` and `waived` approval fails without a reason and succeeds with
  one.
- Successful approval stores approval metadata in the readiness snapshot and
  emits the readiness approval event.
- Approval waits for in-flight advisory QA, then recomputes readiness before
  applying reason rules.
- Auto-approval skips `needs_review`, `risky`, and `waived`.
- Approve-all skips `needs_review`, `risky`, and `waived` and reports skipped
  pods.
- Single-PR series approval uses Series Readiness and requires a reason when the
  rollup is `risky` or `waived`.

## Wrap-up

Before finishing:

1. Run focused daemon approval and route tests.
2. Run `npx pnpm --filter @autopod/daemon test -- pod-manager.test.ts -t "readiness approval"`.
3. Run `npx pnpm --filter @autopod/daemon test -- pods.test.ts -t "approve"`.
4. Commit and push.
