# Brief: Container Filesystem Gating (Sensitive-Path PR Guard)

## Objective

Close the data-plane escape where a compromised agent uses the `/mnt/worktree`
bind-mount to modify files whose changes wouldn't be caught by normal code
review — specifically CI workflows, `CLAUDE.md`, daemon-injected sections,
registry configs, and skill/hook definitions. These are the paths where a small
diff lets an attacker poison future sessions, exfiltrate secrets via CI, or
pivot into production deployment pipelines.

The worktree mount itself stays — it's how the agent edits code at all. The
fix is **at the PR boundary**: when the agent tries to push changes that touch
any path on the sensitive-paths list, the daemon must

1. **Refuse auto-merge** regardless of profile `autoMerge` setting,
2. **Flag the PR** with an explicit "sensitive-paths-touched" label and a body
   callout listing the paths + diff snippets, and
3. **Optionally trigger a `report_blocker`-style escalation** to a human before
   the PR is created, for profiles that opt into stricter mode.

Detection is diff-based (post-commit, pre-PR). No filesystem-layer enforcement,
no in-container git hooks (pods can disable them). The boundary is the daemon's
`GitHubApiPrManager` / `AdoPrManager`, not the container.

## Sensitive paths (v1 list)

Exact matches or glob patterns evaluated against the diff's added/modified/deleted file set:

- `**/.github/workflows/**`
- `**/.gitlab-ci.yml`, `**/azure-pipelines.yml`, `**/bitbucket-pipelines.yml`
- `CLAUDE.md` (root only) and `**/CLAUDE.md` (any subdirectory)
- `.claude/**` (skills, hooks, settings)
- `**/.npmrc`, `**/NuGet.config`, `**/nuget.config`
- `**/.env*` (safety net — should never be committed, but catch it anyway)
- `**/secrets.*`, `**/*.pem`, `**/*.key` (same — belt and suspenders)

The list lives in a single constant (`SENSITIVE_PATH_PATTERNS`) so it can grow
without touching callers. Profiles MAY extend it via
`profile.sensitivePathPatterns?: string[]` (concatenated to the default list,
never replacing it).

## Files

| File | Action | Notes |
|------|--------|-------|
| `packages/shared/src/sensitive-paths.ts` | create | Export `SENSITIVE_PATH_PATTERNS: string[]` and `isSensitivePath(path, extra?): boolean`. Use `micromatch` (already a transitive dep via turbo) or a hand-rolled glob matcher — no new top-level deps. |
| `packages/shared/src/sensitive-paths.test.ts` | create | Glob-matching truth table: `.github/workflows/ci.yml` → true, `src/workflows/foo.ts` → false, `packages/x/CLAUDE.md` → true, `CLAUDE.md.bak` → false, etc. |
| `packages/shared/src/index.ts` | modify | Re-export `SENSITIVE_PATH_PATTERNS` and `isSensitivePath`. |
| `packages/shared/src/types/profile.ts` | modify | Add optional `sensitivePathPatterns?: string[]` to `Profile`. |
| `packages/daemon/src/worktrees/diff-scanner.ts` | create | `scanDiffForSensitivePaths(diff: DiffEntry[], extraPatterns?: string[]): SensitivePathHit[]`. Runs after `git diff --name-status` against the PR base. Returns the list of matched paths + their change type (add/mod/delete). |
| `packages/daemon/src/worktrees/diff-scanner.test.ts` | create | Unit tests with synthetic diff entries. |
| `packages/daemon/src/worktrees/pr-body-builder.ts` | modify | If `sensitivePathHits.length > 0`, prepend a `> ⚠ Sensitive paths touched — auto-merge blocked` callout + a fenced list. |
| `packages/daemon/src/worktrees/pr-manager.ts` (`GitHubApiPrManager`) | modify | Before `createPr`, compute `sensitivePathHits`. If non-empty: force `autoMerge = false` on the created PR, add label `autopod:sensitive-paths`. |
| `packages/daemon/src/worktrees/ado-pr-manager.ts` | modify | Mirror the GitHub changes (ADO equivalent of labels + auto-complete disablement). |
| `packages/daemon/src/sessions/session-manager.ts` | modify | When the PR manager reports `sensitivePathHits`, emit a `SystemEvent` (`pr.sensitive_paths_blocked`) so the desktop/CLI surfaces it. Set `session.sensitivePathHits` on the row (new column). |
| `packages/daemon/src/db/migrations/0NN_sensitive_path_hits.sql` | create | Add `sessions.sensitive_path_hits TEXT` (JSON array, nullable). **Check current highest migration number first** (`ls packages/daemon/src/db/migrations | tail -5`) — never reuse a prefix. |
| `packages/daemon/src/sessions/session-repository.ts` | modify | Serialise/deserialise the new column. |
| `packages/daemon/CLAUDE.md` | modify | Add a short section describing the gating behaviour + how to extend the pattern list via a profile. |

**Not modified**:
- `docker-container-manager.ts` — the mount itself is correct; no filesystem-layer changes.
- Agent-visible container (CLAUDE.md inside `/mnt/worktree`) — we do NOT warn the agent that paths are gated, because that just tells a malicious pod which paths to avoid naming. Detection is silent on the agent side, loud on the human side.

## Out of scope for v1

- **Mid-session blocking.** We detect at PR creation, not mid-edit. A pod that writes a file and deletes it before commit is invisible — that's acceptable because nothing downstream is harmed.
- **Read gating.** Reading `.env` via the mount is already considered in-scope for the agent (it needs to read source); if secrets end up in the worktree that's a separate hygiene issue (covered by the `.env*` pattern only catching *writes* back into a commit).
- **Host-side fs ACLs.** macOS FSEvents / LaunchDaemons to watch the worktree dir for writes. Out of scope — diff-layer is sufficient and cross-platform.
- **Rewriting .git config.** The `.git` gitdir path leak (`/Users/ewi/.autopod/repos/...`) is info-disclosure-only and doesn't warrant worktree reshaping; document as known.

## Acceptance criteria (summary)

See `acceptance-criteria.md`. Headline items:

1. A PR produced by a session that modifies `.github/workflows/ci.yml` has `autoMerge=false` on GitHub regardless of profile config, and carries the `autopod:sensitive-paths` label.
2. The PR body starts with a visible callout listing every sensitive path touched.
3. Profile-defined extra patterns extend (not replace) the default list.
4. `SENSITIVE_PATH_PATTERNS` unit tests cover all defaults with positive and negative examples.
5. `session.sensitivePathHits` is populated on the session row for UI consumption; desktop app receives a `pr.sensitive_paths_blocked` event.
