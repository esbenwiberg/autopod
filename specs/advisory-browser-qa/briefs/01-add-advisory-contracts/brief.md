---
title: "Add advisory browser QA contracts"
touches:
  - packages/shared/src/types/profile.ts
  - packages/shared/src/schemas/profile.schema.ts
  - packages/shared/src/types/pod-options.ts
  - packages/shared/src/types/validation.ts
  - packages/shared/src/evidence.ts
  - packages/shared/src/schemas/profile.schema.test.ts
does_not_touch:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/desktop/
---

## Task
Add the shared contracts for advisory browser QA. The contracts must express a
tri-state profile default, a per-pod override, an advisory validation result,
observation records, and the new screenshot source `advisory`.

## Touches
Update the shared profile type/schema, pod options, validation types, evidence
renderer, and focused schema/evidence tests.

## Does not touch
Do not wire daemon execution or desktop rendering in this brief.

## Constraints
Follow `docs/ideas/scenario-browser-qa.md`: advisory browser QA is evidence,
not proof. Keep required facts as the blocking proof layer. Do not add advisory
browser QA to `ValidationPhase`.

## Test expectations
Add schema tests for `advisoryBrowserQaEnabled` inheritance behavior and evidence
tests for advisory result rendering.

## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
