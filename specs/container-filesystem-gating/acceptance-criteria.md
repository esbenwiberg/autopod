# Acceptance Criteria: Container Filesystem Gating

## Detection

- [ ] `isSensitivePath('.github/workflows/ci.yml')` → true
- [ ] `isSensitivePath('packages/web/CLAUDE.md')` → true
- [ ] `isSensitivePath('CLAUDE.md')` → true
- [ ] `isSensitivePath('docs/CLAUDE.md.bak')` → false
- [ ] `isSensitivePath('.claude/skills/foo.md')` → true
- [ ] `isSensitivePath('src/claude-test.ts')` → false
- [ ] `isSensitivePath('.npmrc')` → true
- [ ] `isSensitivePath('NuGet.config')` → true
- [ ] `isSensitivePath('nuget.config')` → true (case-insensitive on the file-name portion)
- [ ] `isSensitivePath('.env.production')` → true
- [ ] `isSensitivePath('src/.env.example')` → true
- [ ] `isSensitivePath('src/env-utils.ts')` → false
- [ ] Profile-defined `sensitivePathPatterns: ['deploy/**']` extends defaults — `deploy/stack.yml` → true, `.github/workflows/ci.yml` also still true.
- [ ] Empty profile list is a no-op — defaults still apply.

## Diff scanner

- [ ] `scanDiffForSensitivePaths` returns hits for add, modify, and delete change types.
- [ ] A diff with no sensitive paths returns an empty array.
- [ ] A diff with renames where the **new** path is sensitive counts as a hit.
- [ ] A diff with renames where the **old** path is sensitive (rename *away* from sensitive) also counts as a hit (the original file's removal is consequential).

## GitHub PR behaviour

- [ ] When `sensitivePathHits.length > 0`, `GitHubApiPrManager.createPr` creates the PR with auto-merge disabled even if the profile sets `autoMerge: true`.
- [ ] The PR carries the label `autopod:sensitive-paths` (created if it doesn't exist on the repo).
- [ ] The PR body starts with a `> ⚠ Sensitive paths touched — auto-merge blocked` callout followed by a fenced list of the paths and their change types.
- [ ] When `sensitivePathHits.length === 0`, behaviour is unchanged — no label, no callout, profile auto-merge honoured.

## ADO PR behaviour

- [ ] Mirror of GitHub: auto-complete disabled, PR tagged `autopod:sensitive-paths`, body callout prepended.

## Persistence + events

- [ ] `sessions.sensitive_path_hits` stores a JSON array of `{ path, changeType }` objects, or NULL when there were no hits.
- [ ] The migration number is the next unused prefix (check `ls packages/daemon/src/db/migrations | tail -5`).
- [ ] A `pr.sensitive_paths_blocked` event is emitted on the event bus when the PR is created with hits.
- [ ] Replaying events preserves the hits on session reload.

## Security invariants

- [ ] Agent-visible surfaces (container CLAUDE.md, system-instructions) do **not** mention the gating behaviour — no hints about which paths are sensitive.
- [ ] The feature is active by default — no profile opt-in required for the base list.
- [ ] Existing unit tests that assert `autoMerge: true` behaviour still pass when the diff contains no sensitive paths.

## Regression safety

- [ ] `./scripts/validate.sh` passes.
- [ ] No new top-level dependencies added to any package's `package.json`.
- [ ] PR creation latency increase is negligible (< 100 ms overhead for typical diffs under 1 000 files).
