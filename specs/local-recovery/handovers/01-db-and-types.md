# Handover: 01-db-and-types

## Status
complete

## Summary
Added `recoveryWorktreePath: string | null` to the `Session` interface in shared types, created migration `015_recovery_worktree_path.sql` to add the `recovery_worktree_path TEXT DEFAULT NULL` column to the sessions table, and updated the row mapper and update handler in `session-repository.ts` to serialize/deserialize the field. The brief referenced a separate `session-row-mapper.ts` file, but the mapping logic lives inline in `session-repository.ts` -- so that file was modified instead.

## Deviations from Plan
- The brief listed `packages/daemon/src/db/session-row-mapper.ts` as a file to modify, but no such file exists. The row mapping (`rowToSession`) and update logic live in `packages/daemon/src/sessions/session-repository.ts`, which was modified instead.
- Also added `recoveryWorktreePath` to the `SessionUpdates` interface and the `update()` method in `session-repository.ts` so downstream briefs can actually set the field on a session without needing further schema changes.

## Contract Changes
All contracts honored as specified.

## Downstream Impacts
- All downstream briefs that need to read/write `recoveryWorktreePath` can do so through the existing `SessionRepository.update()` and `SessionRepository.getOrThrow()` methods -- no additional plumbing needed.
- The field defaults to `null` in SQLite, so all existing sessions and test fixtures work without modification.

## Discovered Constraints
- 5 pre-existing test failures in daemon package (copilot-runtime, session-manager workspace tests, system-instructions-generator) unrelated to this change.

## Files Changed
| File | Action | Notes |
|------|--------|-------|
| `packages/shared/src/types/session.ts` | modified | Added `recoveryWorktreePath: string \| null` to `Session` interface |
| `packages/daemon/src/db/migrations/015_recovery_worktree_path.sql` | created | ALTER TABLE adding nullable column |
| `packages/daemon/src/sessions/session-repository.ts` | modified | Added field to `rowToSession()`, `SessionUpdates`, and `update()` method |

## Acceptance Criteria Status
- [x] `Session` type includes `recoveryWorktreePath: string | null`
- [x] Migration adds column to sessions table
- [x] Row mapper correctly serializes/deserializes the field
- [x] Existing tests still pass (field defaults to null) -- 5 pre-existing failures unrelated to this change
- [x] `npx pnpm build` succeeds across all packages
