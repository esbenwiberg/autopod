# Brief 02: Daemon Provisioning

## Objective

Make `session-manager.ts` correctly provision artifact sessions: optional worktree creation,
no worktree volume mount in container, reference repo cloning, agent spawn with artifact-mode
system instructions.

## Dependencies

- Brief 01 (types and schema)

## Blocked By

- Brief 03 (uses the provisioned containerId and worktreePath)

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/sessions/session-manager.ts` | modify | Provisioning block (lines ~1200-1380) |
| `packages/daemon/src/sessions/system-instructions-generator.ts` | modify | Reference repos section |

## Interface Contracts

Consumes: `Session.referenceRepos`, `Session.artifactsPath`, `Profile.repoUrl` (nullable)
Produces: container with `/repos/<name>/` cloned, agent running with artifact-mode CLAUDE.md

## Implementation Notes

### session-manager.ts — Worktree creation (around line 1212)

Wrap the entire worktree creation block in a `profile.repoUrl` guard:

```ts
let worktreePath: string | null = null
let bareRepoPath: string | null = null

if (profile.repoUrl) {
  // existing recovery + create logic unchanged, just now conditional
  if (recoveryViable && session.recoveryWorktreePath) {
    worktreePath = session.recoveryWorktreePath
    bareRepoPath = await deriveBareRepoPath(worktreePath)
    sessionRepo.update(sessionId, { recoveryWorktreePath: null })
  } else {
    emitStatus('Creating worktree…')
    const result = await worktreeManager.create({
      repoUrl: profile.repoUrl,
      branch: session.branch,
      baseBranch: session.baseBranch ?? profile.defaultBranch,
      pat: profile.adoPat ?? profile.githubPat ?? undefined,
    })
    worktreePath = result.worktreePath
    bareRepoPath = result.bareRepoPath
  }
}
```

Downstream references to `worktreePath` and `bareRepoPath` are already `string | null` in the
`Session` type — verify that `session.worktreePath` usages in the file handle null gracefully
(most already do via optional chaining).

### session-manager.ts — Container volumes (around line 1297)

Current:
```ts
volumes: [
  { host: worktreePath, container: '/mnt/worktree' },
  { host: bareRepoPath, container: bareRepoPath },
],
```

Change to:
```ts
volumes: [
  ...(worktreePath ? [{ host: worktreePath, container: '/mnt/worktree' }] : []),
  ...(bareRepoPath ? [{ host: bareRepoPath, container: bareRepoPath }] : []),
],
```

### session-manager.ts — Workspace copy (around line 1310)

Current: `cp -a /mnt/worktree/. /workspace/` — only valid when worktree was mounted.

Change to:
```ts
if (worktreePath) {
  await containerManager.execInContainer(
    containerId,
    ['cp', '-a', '/mnt/worktree/.', '/workspace/'],
    { timeout: 120_000 },
  )
}
// For artifact mode with no worktree, /workspace starts empty — that's correct.
```

### session-manager.ts — Reference repo cloning (after workspace copy, before agent spawn)

Add after the workspace copy block:
```ts
if (session.referenceRepos?.length) {
  emitStatus('Cloning reference repos…')
  await containerManager.execInContainer(containerId, ['mkdir', '-p', '/repos'], { timeout: 5_000 })
  for (const repo of session.referenceRepos) {
    const destPath = `/repos/${repo.mountPath}`
    const refPat = session.profileSnapshot?.githubPat ?? undefined
    // referenceRepoPat is stored transiently — read from CreateSessionRequest at session creation
    // and stored on profileSnapshot or a dedicated field. See note below.
    const authUrl = refPat ? injectPatIntoUrl(repo.url, refPat) : repo.url
    try {
      await containerManager.execInContainer(
        containerId,
        ['git', 'clone', '--depth', '1', authUrl, destPath],
        { timeout: 60_000 },
      )
      if (refPat) {
        // Strip PAT from remote so it's not readable inside the container
        await containerManager.execInContainer(
          containerId,
          ['git', 'remote', 'set-url', 'origin', repo.url],
          { cwd: destPath, timeout: 5_000 },
        )
      }
      logger.info({ sessionId, repo: repo.url, destPath }, 'Cloned reference repo')
    } catch (err) {
      // Non-fatal: log warning, agent gets a note
      logger.warn({ err, sessionId, repo: repo.url }, 'Failed to clone reference repo — skipping')
    }
  }
}
```

**Note on referenceRepoPat storage**: `referenceRepoPat` from `CreateSessionRequest` must be
persisted on the session (encrypted, like `adoPat`/`githubPat`). Add a `referenceRepoPat`
column in migration 040 OR store it via `profile.githubPat` if it's the same PAT. Simplest:
add `reference_repo_pat TEXT DEFAULT NULL` to sessions in migration 040, encrypted at rest
using the same cipher as `adoPat`. Coordinate with Brief 01 to add this column and the
session type field.

### session-manager.ts — Artifact outputMode early return (around line 1379)

Artifact sessions DO spawn an agent — there is NO early return here. The `outputMode === 'workspace'`
block at line 1379 is NOT duplicated for artifact. Continue to the agent spawn path.

The branch and system instructions must be set correctly before spawn:
- Branch for artifact sessions: `research/${session.id}` — set this during session creation
  in `createSession()`, not here. Follow the existing `branchPrefix` logic:
  look for where `session.branch` is derived from `branchPrefix` and add an artifact-mode
  case that sets it to `research/${nanoid(SESSION_ID_LENGTH)}`.

### system-instructions-generator.ts — Reference repos section

In the artifact mode branch (around lines 161-182), add a reference repos section when
`referenceRepos` is non-empty:

```ts
if (session.referenceRepos?.length) {
  lines.push('## Reference Repositories')
  lines.push('The following repos are cloned read-only at these paths:')
  for (const repo of session.referenceRepos) {
    lines.push(`- \`/repos/${repo.mountPath}/\` — ${repo.url}`)
  }
  lines.push('')
}
```

Also update the artifact-mode guidelines section to mention:
- Web search is available via standard Claude tools (WebFetch, WebSearch)
- Write all output files to `/workspace/` — they will be collected as artifacts
- Reference repos at `/repos/` are read-only (do not attempt to push there)

## Acceptance Criteria

- [ ] Artifact session with no `profile.repoUrl` provisions without error (no worktree created)
- [ ] Artifact session with `profile.repoUrl` creates a worktree but does NOT mount it in the container
- [ ] Container `/workspace/` is empty (not populated from worktree) for artifact sessions
- [ ] Each reference repo appears at `/repos/<mountPath>/` inside the container
- [ ] Failed reference repo clone logs a warning but does not fail the session
- [ ] System instructions include reference repo paths when present
- [ ] Agent spawns successfully for artifact sessions (not early-returned like workspace)
- [ ] Branch for artifact sessions is `research/<id>` format
- [ ] TypeScript strict mode passes

## Estimated Scope

Files: 2 | Complexity: medium
