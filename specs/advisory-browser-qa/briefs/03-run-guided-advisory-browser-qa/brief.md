---
title: "Run guided advisory browser QA"
touches:
  - packages/daemon/src/validation/advisory-browser-qa-runner.ts
  - packages/daemon/src/validation/advisory-browser-qa-runner.test.ts
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/daemon/src/validation/local-validation-engine.test.ts
  - packages/daemon/src/api/wire-serializers.ts
  - packages/daemon/src/api/wire-serializers.test.ts
does_not_touch:
  - packages/shared/src/types/profile.ts
  - packages/desktop/
---

## Task
Implement guided advisory browser QA. It should run after blocking checks are
green, drive the running web app from contract scenarios plus human_review
items, capture notes/screenshots, and record concerns as advisory evidence only.

## Touches
Add the runner module and tests, wire it into local validation, and serialize
advisory screenshot refs.

## Does not touch
Do not change profile storage or desktop rendering in this brief.

## Constraints
Run only when enabled, effective `hasWebUi` is true, health has passed, blocking
checks and AI review are not failing, and the contract has at least one scenario
or human_review item. Cap each run at 5 checklist targets. Use skip reason
`no-contract-checklist` when both lists are empty.

## Test expectations
Mock the host browser runner and reviewer/model boundary. Cover complete, skip,
concern, error, screenshot capture, and cap behavior.

## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
