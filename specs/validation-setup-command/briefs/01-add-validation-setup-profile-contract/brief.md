---
title: "Add validation setup profile contract"
touches:
  - packages/shared/src/types/profile.ts
  - packages/shared/src/schemas/profile.schema.ts
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/profiles/profile-store.ts
  - packages/daemon/src/profiles/profile-validator.ts
  - packages/cli/src/commands/profile.ts
does_not_touch:
  - packages/daemon/src/validation/local-validation-engine.ts
  - packages/escalation-mcp/
  - packages/desktop/
---

## Task
Add `validationSetupCommand` as a nullable profile field, allow `setup` in
`skipValidationPhases`, persist both through the daemon profile store, validate
dangerous command patterns, and expose the new field through CLI profile
template/show/edit flows.

Add the next migration prefix after the current highest migration. At planning
time the highest known migration was `111_agent_done_prompt.sql`; recheck before
writing the migration.

## Touches
Update the shared profile type/schema, daemon migration/profile store/profile
validator, and CLI profile command surface.

## Does not touch
Do not implement setup execution, MCP `validate_locally`, or desktop rendering
in this brief.

## Constraints
Use `/add-profile-field`. This brief starts the profile-field checklist, and
the Desktop layers are completed by later briefs. Do not backfill existing
profiles or rewrite existing `buildCommand` values.

## Test expectations
Cover schema parsing, dangerous command validation, skip phase validation,
profile persistence, inheritance/null behavior, and CLI exposure.

## Risks / pitfalls
Migration prefixes are version numbers. Do not reuse `111`; choose the next
available prefix after rechecking `packages/daemon/src/db/migrations/`.

## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run focused tests named in `contract.yaml`.
3. Commit and push.
