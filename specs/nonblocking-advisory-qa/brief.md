---
title: "Make advisory browser QA nonblocking"
touches:
  - packages/daemon/src/interfaces/validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/test-utils/mock-helpers.ts
does_not_touch:
  - packages/shared/src/types/events.ts
  - packages/shared/src/types/validation.ts
  - packages/desktop/
  - packages/daemon/src/db/migrations/
---

## Task

Make Advisory Browser QA stop delaying PR creation when all blocking validation checks have
passed. Normal validation and Resume/revalidation should create or carry forward the PR and
mark the pod validated before advisory browser QA finishes, while keeping the container
running until advisory browser QA is done when advisory is enabled.

## Why

Advisory Browser QA is useful screenshot-backed evidence, but it is not durable enough to be
a merge gate. Today it is nonblocking in the final `overall` result but still blocks
time-to-PR because `validationEngine.validate()` awaits it before the daemon can create the
PR.

## Touches

- `packages/daemon/src/interfaces/validation-engine.ts` may need a daemon-internal API or
  option that separates blocking validation from advisory browser QA.
- `packages/daemon/src/validation/local-validation-engine.ts` should stop running advisory
  browser QA inline with blocking validation, while preserving the existing advisory result
  shape and skip behavior for the later advisory pass.
- `packages/daemon/src/validation/local-validation-engine.test.ts` should prove blocking
  validation returns without running advisory inline.
- `packages/daemon/src/pods/pod-manager.ts` should run advisory browser QA after successful
  blocking validation has created or carried forward a PR and transitioned the pod to
  `validated`, both for normal validation and Resume/revalidation.
- `packages/daemon/src/pods/pod-manager.test.ts` should cover PR ordering, container
  lifetime, and event behavior for both normal validation and Resume/revalidation.
- `packages/daemon/src/test-utils/mock-helpers.ts` may need mock validation-engine support
  for the separated advisory path.

## Does not touch

- `packages/shared/src/types/events.ts` stays unchanged; keep the existing advisory phase
  event shape that desktop already consumes.
- `packages/shared/src/types/validation.ts` stays unchanged; keep
  `ValidationResult.advisoryBrowserQa` as the persisted evidence location.
- `packages/desktop/` stays unchanged; avoid new client behavior by continuing to emit
  advisory phase events.
- `packages/daemon/src/db/migrations/` stays unchanged; this is not a schema migration.

## Constraints

- `docs/decisions/ADR-027-advisory-browser-qa-evidence-not-validation.md` is the governing
  decision: advisory browser QA is "evidence only" and "nonblocking".
- Preserve one normal `pod.validation_completed` event for the blocking validation result.
  Do not emit a second `pod.validation_completed` after advisory finishes; desktop treats
  that event as a validation-complete notification trigger.
- After the blocking validation result passes, create or carry forward the PR before
  advisory browser QA finishes.
- When advisory browser QA is enabled and scheduled, do not stop the container at the
  `validated` transition. Keep it running for advisory, then stop it after the advisory pass
  completes or skips.
- When advisory browser QA is disabled, preserve the current post-validation container stop
  behavior.
- Advisory findings, errors, uncertainty, or skipped advisory runs must not change
  `ValidationResult.overall`, pod status, PR creation, retry behavior, or auto-approve
  eligibility.
- Preserve existing `skipValidationPhases: ['advisory']` semantics: an enabled-but-skipped
  advisory run should record/emit an advisory skip result without running browser QA.
- Preserve screenshot collection/serialization behavior for advisory evidence; late advisory
  screenshots should still resolve through the existing screenshot store and wire serializer.
- Avoid a broad shared/desktop cleanup even though ADR-027 says advisory is not a validation
  phase. Removing `advisory` from shared `ValidationPhase` is out of scope for this pod.

## Skills to reference

None.

## Test expectations

Update daemon tests so the behavior is proven without relying on generic pipeline checks:

- **Blocking validation does not run advisory inline**:
  `local-validation-engine.test.ts` should prove `validate()` returns a passing blocking
  validation result without invoking the host browser runner for advisory browser QA, even
  when advisory is enabled and the blocking checks are green.
- **Normal validation creates PR before advisory finishes**:
  `pod-manager.test.ts` should use a controllable advisory promise or equivalent mock to
  prove the PR is created and the pod reaches `validated` before advisory completion.
- **Normal validation keeps the container alive for advisory**:
  `pod-manager.test.ts` should prove `containerManager.stop` is not called while advisory is
  still running, then is called after advisory finishes.
- **Resume/revalidation has the same ordering**:
  `pod-manager.test.ts` should prove the Resume/revalidation path creates or carries forward
  the PR before advisory finishes and keeps the container running until advisory completes.
- **No duplicate validation-complete event**:
  `pod-manager.test.ts` should prove advisory completion emits advisory phase progress/result
  but does not emit a second `pod.validation_completed` event.

Required fact command:

```bash
npx pnpm --filter @autopod/daemon test -- pod-manager.test.ts local-validation-engine.test.ts
```

## Risks / pitfalls

- If advisory is moved to a detached fire-and-forget task, container cleanup can race it.
  The daemon must keep a clear lifecycle handoff: PR/validated first, advisory second,
  container stop third.
- If advisory completion rewrites the whole validation result and emits
  `pod.validation_completed`, desktop may show duplicate validation-complete notifications.
- Auto-approve can begin after `validated`; advisory must remain advisory even if approval or
  merge starts while advisory evidence is still being collected.
- Failure paths must stay boring: advisory errors should be logged, persisted as advisory
  evidence when possible, and never send the pod back to the agent.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Run `npx pnpm --filter @autopod/daemon test -- pod-manager.test.ts local-validation-engine.test.ts`.
3. Re-run build and tests; both must still pass.
4. Commit and push.
