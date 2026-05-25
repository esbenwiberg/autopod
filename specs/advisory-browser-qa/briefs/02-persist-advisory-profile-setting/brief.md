---
title: "Persist advisory browser QA profile setting"
touches:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/profiles/profile-store.ts
  - packages/daemon/src/profiles/profile-validator.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/api/routes/screenshots.ts
  - packages/daemon/src/api/wire-serializers.ts
  - packages/cli/src/commands/profile.ts
does_not_touch:
  - packages/daemon/src/validation/advisory-browser-qa-runner.ts
  - packages/desktop/
---

## Task
Persist `advisoryBrowserQaEnabled`, validate it, pass the effective advisory QA
setting into validation, and expose the field through the CLI. Add the next
migration prefix after the current highest migration, which was
`104_remove_acceptance_criteria.sql` at planning time.

## Touches
Update daemon profile storage, validation config wiring, screenshot API source
validation, wire serialization for advisory screenshots, and CLI profile editing.

## Does not touch
Do not implement the guided browser runner or desktop UI in this brief.

## Constraints
Use `/add-profile-field`; this profile field must reach shared types, migration,
store, validator, desktop layers, and CLI across the series. Do not add advisory
QA to `skipValidationPhases`.

## Test expectations
Cover profile inheritance/persistence, effective pod override precedence, and
advisory screenshot source API behavior.

## Risks / pitfalls
Migration prefixes are version numbers. Do not reuse `104`; choose the next
available prefix after rechecking `packages/daemon/src/db/migrations/`.

## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
