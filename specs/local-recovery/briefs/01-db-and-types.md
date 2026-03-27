# Brief: DB Schema + Shared Types

## Objective
Add the `recoveryWorktreePath` field to the session type and database schema
so the reconciler can flag sessions for recovery and `processSession()` can
detect recovery mode.

## Dependencies
None — this is the foundation brief.

## Blocked By
Nothing.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/shared/src/types/session.ts` | modify | Add `recoveryWorktreePath: string \| null` field |
| `packages/daemon/src/db/migrations/` | create | New migration file adding `recovery_worktree_path TEXT DEFAULT NULL` column |
| `packages/daemon/src/db/session-row-mapper.ts` | modify | Map `recovery_worktree_path` ↔ `recoveryWorktreePath` |

## Implementation Notes

- Follow existing migration naming pattern (check last migration number, increment)
- The field is nullable — only set during recovery, null during normal operation
- Add to the existing `SessionRow` ↔ `Session` mapping in the row mapper
- No index needed — we never query by this field

## Acceptance Criteria

- [ ] `Session` type includes `recoveryWorktreePath: string | null`
- [ ] Migration adds column to sessions table
- [ ] Row mapper correctly serializes/deserializes the field
- [ ] Existing tests still pass (field defaults to null)
- [ ] `npx pnpm build` succeeds across all packages

## Estimated Scope
Files: 3 | Complexity: low
