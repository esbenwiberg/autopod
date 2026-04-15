# Brief 03: Daemon Completion + Files API

## Objective

Hook artifact collection into `handleCompletion` for `outputMode === 'artifact'` sessions:
extract `/workspace/` from the container, store locally, optionally push a branch, update
the files API to serve artifacts when `worktreePath` is null.

## Dependencies

- Brief 01 (types and schema)
- Brief 02 (container must be running/stopped with artifacts in `/workspace/`)

## Blocked By

- Brief 05 (desktop reads artifacts via files API)

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/daemon/src/sessions/session-manager.ts` | modify | `handleCompletion` method (lines 1939-2030) |
| `packages/daemon/src/api/routes/files.ts` | modify | Fall back to `artifactsPath` when `worktreePath` is null |

## Interface Contracts

Consumes: `Session.worktreePath`, `Session.referenceRepos`, `Session.artifactsPath`, `ContainerManager.extractDirectoryFromContainer()`
Produces: `session.artifactsPath` set, files API serving artifacts

## Implementation Notes

### session-manager.ts — handleCompletion (lines 1939-2030)

Add an artifact-mode branch immediately after the guard block (line 1953):

```ts
// Artifact sessions: collect /workspace/, optionally push branch, skip validation
if (session.outputMode === 'artifact') {
  const dataDir = deps.dataDir ?? path.join(process.cwd(), '.autopod-data')
  const artifactsPath = path.join(dataDir, 'artifacts', sessionId)
  await fs.mkdir(artifactsPath, { recursive: true })

  if (session.containerId) {
    const cm = containerManagerFactory.get(session.executionTarget)
    try {
      emitStatus('Collecting artifacts…')
      await cm.extractDirectoryFromContainer(session.containerId, '/workspace', artifactsPath)
      logger.info({ sessionId, artifactsPath }, 'Artifacts extracted')
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to extract artifacts — continuing')
    }
  }

  sessionRepo.update(sessionId, { artifactsPath })

  // Push branch if profile has a destination repo
  if (session.worktreePath) {
    try {
      emitStatus('Pushing artifact branch…')
      // Copy artifacts into worktree
      await execFileAsync('cp', ['-a', `${artifactsPath}/.`, session.worktreePath])
      // Auto-commit
      await worktreeManager.commitPendingChanges(
        session.worktreePath,
        `research: ${session.task.slice(0, 72)}`,
        { maxDeletions: 1000 },
      )
      // Push branch (no PR)
      await worktreeManager.pushBranch(session.worktreePath, session.branch, {
        pat: profile.adoPat ?? profile.githubPat ?? undefined,
      })
      logger.info({ sessionId, branch: session.branch }, 'Artifact branch pushed')
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to push artifact branch — artifacts still available via API')
    }
  }

  transition(session, 'complete')
  return
}
```

**Where to insert**: immediately after the early-exit guard (line 1953), before the
`syncWorkspaceBack` call at line 1955. This means the existing sync/commit/validate path
is completely bypassed for artifact sessions.

**`deps.dataDir`**: The session manager constructor options (`SessionManagerDeps`) need a
`dataDir?: string` field. Default to `process.cwd()/.autopod-data`. Callers (daemon index.ts)
should pass `DB_PATH`'s directory or a dedicated data dir env var. This is a small addition
to the deps interface.

**`worktreeManager.pushBranch`**: Verify this method exists and check its signature. If it
doesn't exist (workspace pods use a different path), find the equivalent in
`local-worktree-manager.ts` — look for `push` near lines 400-500.

### api/routes/files.ts — artifactsPath fallback

The route currently reads `session.worktreePath` to resolve the file root. Find that lookup
(likely near lines 42-59 for the list endpoint and 62-109 for content).

Change:
```ts
// Before
const rootPath = session.worktreePath
if (!rootPath) return reply.code(404).send({ error: 'No worktree' })

// After
const rootPath = session.worktreePath ?? session.artifactsPath
if (!rootPath) return reply.code(404).send({ error: 'No files available' })
```

Apply the same change to both the list endpoint and the content endpoint.
The path traversal guard already uses `rootPath` as the base — no additional changes needed.

## Acceptance Criteria

- [ ] Artifact session completion extracts `/workspace/` to `<dataDir>/artifacts/<id>/`
- [ ] `session.artifactsPath` is set after completion
- [ ] If `session.worktreePath` is set, artifacts are copied to worktree and branch is pushed
- [ ] Branch push failure is non-fatal (session still transitions to `complete`)
- [ ] `GET /sessions/:id/files` returns artifact files when `worktreePath` is null
- [ ] `GET /sessions/:id/files/content` returns artifact file content when `worktreePath` is null
- [ ] Non-artifact sessions are unaffected (files route still reads from `worktreePath`)
- [ ] `running → complete` transition succeeds for artifact sessions
- [ ] TypeScript strict mode passes

## Estimated Scope

Files: 2 | Complexity: medium
