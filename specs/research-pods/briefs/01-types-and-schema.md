# Brief 01: Types and Schema

## Objective

Add `ReferenceRepo` type, extend `Session` and `CreateSessionRequest`, make `Profile.repoUrl`
nullable, add DB migration, update session repository and profile validator. Everything downstream
depends on these contracts.

## Dependencies

None.

## Blocked By

Briefs 02, 03, 04 all block on this.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/shared/src/types/session.ts` | modify | Add `ReferenceRepo`, extend `Session` and `CreateSessionRequest` |
| `packages/shared/src/types/profile.ts` | modify | `repoUrl: string` → `repoUrl: string \| null` |
| `packages/daemon/src/db/migrations/040_research_repos.sql` | create | Two new columns on sessions |
| `packages/daemon/src/sessions/session-repository.ts` | modify | Persist/hydrate `referenceRepos` and `artifactsPath` |
| `packages/daemon/src/profiles/profile-validator.ts` | modify | Allow null `repoUrl` when `outputMode === 'artifact'` |

## Interface Contracts

See `contracts.md` for full type definitions.

## Implementation Notes

### shared/src/types/session.ts

Add `ReferenceRepo` interface before `Session`. Extend `Session`:
```ts
referenceRepos: ReferenceRepo[] | null
artifactsPath: string | null
```
Extend `CreateSessionRequest`:
```ts
referenceRepos?: { url: string }[]
referenceRepoPat?: string
```

### shared/src/types/profile.ts:18

Change `repoUrl: string` → `repoUrl: string | null`

### 040_research_repos.sql

```sql
ALTER TABLE sessions ADD COLUMN reference_repos TEXT DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN artifacts_path  TEXT DEFAULT NULL;
```

No profile table change — `repo_url` is already nullable at the SQL level (TEXT without NOT NULL
constraint). Confirm by reading `001_initial.sql` profiles table definition before writing.

### session-repository.ts

Follow the existing `pimGroups` pattern (JSON serialized to TEXT):
- On insert/update: `JSON.stringify(referenceRepos) ?? null`
- On read: `row.reference_repos ? JSON.parse(row.reference_repos) : null`
- Same for `artifactsPath` (plain string, no JSON needed)

### profile-validator.ts:29-41

Current guard: `if (typeof repoUrl !== 'string' || repoUrl.length === 0) errors.push('repoUrl is required')`

Change to: skip the required check (but still validate format) when `input.outputMode === 'artifact'`.
```ts
const isArtifactMode = input.outputMode === 'artifact'
if (!isArtifactMode && (typeof repoUrl !== 'string' || repoUrl.length === 0)) {
  errors.push('repoUrl is required')
} else if (typeof repoUrl === 'string' && repoUrl.length > 0) {
  // validate format as before
}
```

## Acceptance Criteria

- [ ] `ReferenceRepo` is exported from `@autopod/shared`
- [ ] `Session.referenceRepos` and `Session.artifactsPath` exist with correct types
- [ ] `CreateSessionRequest.referenceRepos` and `CreateSessionRequest.referenceRepoPat` exist
- [ ] `Profile.repoUrl` is `string | null` in TypeScript
- [ ] Migration 040 applies cleanly on a fresh DB (run `createTestDb()` in tests)
- [ ] Profile with `outputMode: 'artifact'` and no `repoUrl` passes validation
- [ ] Profile with `outputMode: 'pr'` and no `repoUrl` still fails validation
- [ ] `session-repository` round-trips `referenceRepos` and `artifactsPath` without data loss
- [ ] TypeScript strict mode passes (`npx pnpm build`)

## Estimated Scope

Files: 5 | Complexity: low
