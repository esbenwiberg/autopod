# Research Pods — Interface Contracts

## New types (packages/shared/src/types/session.ts)

```ts
/** A read-only repo cloned into the container at /repos/<mountPath>/ */
export interface ReferenceRepo {
  url: string
  mountPath: string  // derived from last URL segment at session creation time
}
```

## Modified: Session

Add to `Session` interface:
```ts
referenceRepos: ReferenceRepo[] | null
artifactsPath: string | null   // host path where /workspace was extracted on completion
```

## Modified: CreateSessionRequest

Add to `CreateSessionRequest`:
```ts
referenceRepos?: { url: string }[]   // mount paths derived automatically
referenceRepoPat?: string            // one PAT shared across all reference repos (optional)
```

## Modified: Profile

```ts
repoUrl: string | null   // was string — nullable for artifact-only profiles
```

## New DB columns (migration 040)

```sql
-- sessions table
ALTER TABLE sessions ADD COLUMN reference_repos TEXT DEFAULT NULL;  -- JSON ReferenceRepo[]
ALTER TABLE sessions ADD COLUMN artifacts_path TEXT DEFAULT NULL;
```

No change to `profiles` table — `repo_url` already TEXT, just becomes nullable at TS/Zod level.

## API contracts

### GET /sessions/:id/files (existing, modified behaviour)

- When `session.worktreePath` is set: read from worktreePath (existing behaviour)
- When `session.worktreePath` is null AND `session.artifactsPath` is set: read from artifactsPath
- Query param `ext` defaults to `md`

### GET /sessions/:id/files/content (existing, same modification)

- Same fallback: worktreePath → artifactsPath

## Branch naming

Artifact sessions push to: `research/<sessionId>` (8-char ID, same format as session.id)
