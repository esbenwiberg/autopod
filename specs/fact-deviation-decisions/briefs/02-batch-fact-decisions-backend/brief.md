---
title: "Replace single waiver API with batch fact-deviation decisions"
touches:
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.test.ts
does_not_touch:
  - packages/cli/
  - packages/desktop/
  - packages/shared/src/types/task-summary.ts
  - packages/daemon/src/db/migrations/
---

## Task

Replace the one-off `POST /pods/:podId/facts/:factId/approve-waiver` backend
path with a batch domain endpoint for required-fact decisions.

New endpoint:

`POST /pods/:podId/facts/decisions`

Request body:

```ts
{
  decisions: Array<{
    factId: string;
    action:
      | 'waive_required_fact'
      | 'use_replacement_proof'
      | 'enforce_original_fact';
    reason?: string;
  }>;
}
```

Response shape may stay small:

```ts
{ ok: true, newCommits: boolean, result: 'pass' | 'fail' }
```

The endpoint must require exactly one decision for every currently pending
required fact in the latest validation result, apply all decisions to
`pod.taskSummary.factDeviations`, emit a clear activity line, and call
`revalidateSession(podId, { force: true })` once.

## Touches

- `packages/daemon/src/api/routes/pods.ts` - remove the old `/approve-waiver`
  route and add the batch route.
- `packages/daemon/src/api/routes/pods.test.ts` - add route-level coverage for
  success and validation errors.
- `packages/daemon/src/pods/pod-manager.ts` - replace `approveFactWaiver(...)`
  with `decideFactDeviations(...)` or similarly named domain method.
- `packages/daemon/src/pods/pod-manager.test.ts` - add batch, one-revalidation,
  status guard, and unavailable-command activity coverage.
- `packages/daemon/src/validation/local-validation-engine.ts` - keep existing
  decision semantics; only adjust if needed for clearer unavailable-command
  reasoning.
- `packages/daemon/src/validation/local-validation-engine.test.ts` - add/confirm
  coverage for waive, replacement proof, and enforce-original behavior.

## Does Not Touch

Do not add CLI commands. Do not preserve backward compatibility for
`/approve-waiver`. Do not change shared task-summary decision enum values unless
implementation absolutely requires it; API/domain vocabulary can map to the
existing internal `approved_waive`, `approved_replace`, and `rejected` values.

## Constraints

- Allowed pod statuses remain `failed` and `review_required`.
- The endpoint must reject missing, duplicate, unknown, or non-pending fact IDs.
- It must reject partial batches: if two facts are pending, one decision is
  invalid.
- `use_replacement_proof` is valid only when the existing `factDeviations`
  request for that fact includes replacement proof.
- `enforce_original_fact` maps to the existing internal rejected decision and
  lets the validator run the original required fact. Do not add special
  final-fail handling for exit 127 in this task.
- After a successful batch, update task summary once and call
  `revalidateSession(..., { force: true })` exactly once.
- Emit user-visible activity/log wording when a required fact command is
  unavailable, for example:
  `Required fact command unavailable: fact-swift-only (swift not found, exit 127)`.
- The unavailable-command activity is informational; it does not replace the
  existing agent feedback that asks the agent to file `factDeviations`.

## Test Expectations

- Route success: all pending facts have decisions; response is ok; pod manager
  is called once with the whole batch.
- Route validation: missing decisions, duplicate fact IDs, unknown fact IDs,
  non-pending fact IDs, and invalid actions return 4xx with stable error
  codes/messages.
- Manager success: multiple decisions update `taskSummary.factDeviations` in one
  write and revalidate once.
- Manager semantics: `waive_required_fact` maps to `approved_waive`;
  `use_replacement_proof` maps to `approved_replace`; `enforce_original_fact`
  maps to `rejected`.
- Validator semantics: waived facts pass as `waived`; replacement proof runs and
  reports `replaced`; enforced original facts run the original command.
- Unavailable command visibility: when validation returns a pending-human fact
  with `exitCode: 127`, the pod activity/event stream contains a visible line
  naming the fact and unavailable command.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Run focused daemon route, manager, and validation tests.
3. Run `npx pnpm --filter @autopod/daemon test`.
4. Commit and push.
