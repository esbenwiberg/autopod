# Handover: Brief 02 — Daemon Provisioning

## Status: Complete

## What was done

### Migration 041 — profiles.repo_url nullable
`packages/daemon/src/db/migrations/041_profile_repourl_nullable.sql`

Standard SQLite table-rebuild migration to drop `NOT NULL` from `repo_url`. Renames the old table, recreates without the constraint, copies data, drops old table. Matches the exact column list from `001_initial.sql`.

### dockerfile-generator.ts
Wrapped the `git clone` lines inside `if (profile.repoUrl)`. Artifact-mode profiles can now generate a Dockerfile without a repo URL — they just skip the clone step.

### issue-client.ts
`createIssueClient()` throws an explicit error if `profile.repoUrl` is null. Artifact profiles should never reach the issue watcher path, but this makes the failure obvious rather than cryptic.

### session-manager.ts — createSession()
- Introduced `derivedReferenceRepos`: maps `request.referenceRepos` to `ReferenceRepo[]` by deriving `mountPath` from the URL's last path segment (`.git` suffix stripped).
- Branch assignment: artifact sessions (`outputMode === 'artifact'`) now get `research/<id>` as branch. Non-artifact sessions continue using `branchPrefix`.
- `sessionRepo.insert()` now passes `referenceRepos` and `referenceRepoPat`.

### session-manager.ts — worktree block (provisioning)
- `worktreePath` and `bareRepoPath` are now `string | null` (declared at `null`).
- The entire recovery + create worktree block is wrapped in `if (profile.repoUrl)`.
- `acFrom` guard strengthened to `if (session.acFrom && worktreePath)`.

### session-manager.ts — container spawn
- `volumes` array uses spreads: worktree and bareRepo mounts are only included when non-null.
- Workspace copy (`cp -a /mnt/worktree/. /workspace/`) is guarded by `if (worktreePath)`.
- Reference repo cloning: after workspace copy, iterates `session.referenceRepos`, creates `/repos/`, clones with `--depth 1`, strips PAT from remote after clone. Failed clones log a warning and skip — they do not fail the session.

### session-manager.ts — null guards for downstream callers
All three `prManager.createPr()` calls that passed `profile.repoUrl` directly now use `profile.repoUrl ?? undefined` (matching `CreatePrConfig.repoUrl?: string`). `worktreePath` arguments use non-null assertion with biome-ignore where TypeScript can't narrow. `buildReworkTask`, `buildContinuationPrompt`, `buildRecoveryTask` calls all use `worktreePath!` (recovery/rework only happen when a prior run created a worktree).
`buildGitHubImageUrl` is now conditional on `profile.repoUrl` being present.

### system-instructions-generator.ts
- Added `## Reference Repositories` section (after injected skills, before `## Output`) when `session.referenceRepos?.length` is truthy.
- Extended `## Output` for artifact mode with the web search / write-to-workspace guidance.

### injectPatIntoUrl helper
Added module-level helper in session-manager.ts (same pattern as `LocalWorktreeManager.injectPat`): injects `x-access-token:<PAT>@` into an HTTPS URL, stripping any existing userinfo first.

## Key decisions

- **No early return for artifact mode** in processSession. Artifact sessions proceed to agent spawn just like `pr` sessions. Only `workspace` mode returns early.
- **Artifact sessions do NOT create a worktree** even if `profile.repoUrl` is set (the worktree block is skipped entirely for artifact mode based on `profile.repoUrl` being null — artifact profiles are expected to have no repoUrl per the contract).
- **Failed reference repo clones are non-fatal** — warning logged, session continues.
- **PAT is stripped from remote after clone** so the credential doesn't persist inside the container's git config.

## Files modified

| File | Change |
|------|--------|
| `packages/daemon/src/db/migrations/041_profile_repourl_nullable.sql` | new — table rebuild to drop NOT NULL |
| `packages/daemon/src/images/dockerfile-generator.ts` | null guard on repoUrl for git clone |
| `packages/daemon/src/issue-watcher/issue-client.ts` | explicit error for null repoUrl |
| `packages/daemon/src/sessions/session-manager.ts` | main provisioning changes (see above) |
| `packages/daemon/src/sessions/system-instructions-generator.ts` | reference repos section + artifact output note |

## Build status

`npx pnpm build` passes cleanly (5/5 packages). No TypeScript errors.

## What Brief 03 will need

Brief 02 does not handle:
- Artifact session completion path: pushing the `research/<id>` branch and collecting `/workspace/` files as artifacts.
- The `artifactsPath` column is wired at the DB layer (Brief 01) but nothing populates it yet.
- No UI changes — the desktop app does not yet show reference repos or artifact-mode status.
