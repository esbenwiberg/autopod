---
title: "Persist Advisory Results In Validation History"
touches:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/validation-repository.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/pods/validation-repository.test.ts
  - packages/daemon/src/routes-extended.test.ts
  - packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift
  - packages/desktop/Tests/AutopodUITests/
does_not_touch:
  - packages/shared/src/types/validation.ts
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/validation/advisory-browser-qa-runner.ts
  - packages/desktop/Sources/AutopodClient/Types/ValidationResponse.swift
---

## Task

Fix advisory browser QA persistence so a deferred advisory result appears everywhere validation
history is shown. When advisory QA finishes after blocking validation, the matching stored
validation attempt, the `/pods/:podId/validations` API, and the Desktop validation history view
must show the advisory result instead of `advisoryBrowserQa: null`.

## Why

Deferred advisory QA currently updates `pod.lastValidationResult`, but the validation history row
is inserted before advisory finishes. That makes the current pod result and history disagree, and
Desktop can render the selected history attempt without the advisory observations.

## Touches

The daemon fix is expected in `packages/daemon/src/pods/pod-manager.ts` and
`packages/daemon/src/pods/validation-repository.ts`, with regression coverage in
`packages/daemon/src/pods/pod-manager.test.ts`,
`packages/daemon/src/pods/validation-repository.test.ts`, and
`packages/daemon/src/routes-extended.test.ts`.

The Desktop fix is expected in
`packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift`, with Swift coverage under
`packages/desktop/Tests/AutopodUITests/`.

## Does not touch

Do not change the shared validation wire/type shape in
`packages/shared/src/types/validation.ts` or
`packages/desktop/Sources/AutopodClient/Types/ValidationResponse.swift`. Do not add a database
migration under `packages/daemon/src/db/migrations/`; the existing `validations.result` JSON row
is sufficient. Do not change the advisory QA runner itself in
`packages/daemon/src/validation/advisory-browser-qa-runner.ts`.

## Constraints

Advisory browser QA remains advisory only. A failing advisory result must not change
`ValidationResult.overall`, must not block PR creation, and must not become a required fact.

The ordering matters. `runAdvisoryAfterValidation()` currently calls
`validationEngine.runAdvisoryBrowserQa(..., buildPhaseEventCallbacks(podId))`, and the advisory
phase-completed event can reach Desktop before `pod-manager.ts` has merged the advisory result
back into persisted state. Avoid a fix that refreshes Desktop history from the API before the
history row has been updated.

`validation-repository.ts` currently exposes only `insert()` and `getForSession()`. Add the narrow
repository operation needed to update the existing pod/attempt result, rather than inserting a
second attempt row.

## Skills to reference

- None. This does not add a profile field, pod status, or other repo-specific checklist item.

## Test expectations

Add daemon coverage proving a deferred advisory result is merged into the stored validation
attempt for both the normal validation path and the revalidation path. Add repository coverage for
the new history-row update operation, including that it updates only the requested pod/attempt.

Add API coverage proving `GET /pods/:podId/validations` returns the advisory result after deferred
advisory completion, including the usual screenshot reference serialization if screenshots are
present.

Add Desktop coverage proving the Validation tab does not keep rendering stale selected history
after advisory completes. The proof can be a focused helper/model test if direct SwiftUI state
inspection would be brittle, but it must cover the actual refresh condition used by
`ValidationTab.swift`.

## Risks / pitfalls

Do not emit a second `pod.validation_completed` event just to refresh Desktop; existing tests
expect one validation-completed event for the blocking validation result. Prefer a race-safe
advisory phase/history refresh path.

If the implementation changes when the advisory phase-completed event is emitted, keep the live
advisory chip behavior intact: Desktop should still show advisory progress and the final advisory
detail after the phase event.

## Wrap-up

Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
