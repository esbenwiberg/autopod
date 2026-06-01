# initial-mockingbird Handover

## Built

- Added `validationSetupCommand?: string | null` to the shared `Profile` contract and profile schema.
- Added `setup` to the shared validation phase union and to `skipValidationPhases` schema validation.
- Added migration `112_validation_setup_command.sql` with `profiles.validation_setup_command TEXT NULL`.
- Wired `validation_setup_command` through daemon profile-store row mapping, profile creation, and updates.
- Verified `skipValidationPhases: ['setup']` round-trips through shared update parsing and daemon profile-store create/update paths.
- Extended daemon profile validation so `validationSetupCommand` accepts string/null and rejects the same dangerous command patterns as build/lint/SAST commands.
- Exposed the setup command in CLI profile show output, create templates, and edit preservation.
- Added focused tests for shared schema parsing, daemon validation, profile-store persistence/inheritance/null behavior, and CLI show/create/edit coverage.

## Deviations

- The `/add-profile-field` checklist normally includes Desktop layers. This brief explicitly deferred Desktop profile editing/rendering to later briefs, so no Desktop files were changed.
- The actual worktree initially had no `111_agent_done_prompt.sql`, but pre-submit review enforced the planning-time cross-branch collision risk. The migration was moved to `112_validation_setup_command.sql`.
- The brief requested commit and push, but the pod operating environment says not to run `git push`; changes were committed locally and the host system is expected to push.
- Rework found the required tests already passing but made the skip-phase store persistence proof explicit.

## Changed Interfaces

- `Profile.validationSetupCommand?: string | null` is now part of the shared profile contract.
- `ValidationPhase` now includes `'setup'`, which means downstream validation-event and UI code should tolerate setup phases even before execution is implemented.
- `skipValidationPhases` now accepts `'setup'` in shared schema and daemon validation.
- SQLite profiles now have nullable column `validation_setup_command`.

## Owned Files

The next pod should not modify the following without a specific reason:

- `packages/daemon/src/db/migrations/112_validation_setup_command.sql`
- `packages/shared/src/types/profile.ts`
- `packages/shared/src/schemas/profile.schema.ts`
- `packages/daemon/src/profiles/profile-store.ts`
- `packages/daemon/src/profiles/profile-validator.ts`
- `packages/cli/src/commands/profile.ts`
- The new/updated tests for this field in shared, daemon, and CLI packages.

## Constraints And Landmines

- Rechecked migration numbering before creating the file: this worktree had no `111_agent_done_prompt.sql`, but the brief's planning-time note and pre-submit review both identified a cross-branch `111` collision risk. The migration now uses `112`.
- Profile inheritance still follows existing simple-field semantics: raw `null`/missing on a derived profile means inherit from the parent. There is no separate sentinel for an explicit "override to no setup command" on derived profiles in this brief.
- Setup execution is not implemented here. Brief 02 should pass the stored command into validation and decide how to represent setup result events.
