# Research Pods — Validation Plan

## Integration scenarios

### Scenario 1: Pure web research (no repos)

1. Create profile with `outputMode: artifact`, no `repoUrl`
2. `ap research <profile> "summarize the state of LLM benchmarking"`
3. Session reaches `running`, agent uses WebFetch/WebSearch
4. Agent writes `summary.md` to `/workspace/`
5. Session completes, `artifactsPath` is set, `worktreePath` is null
6. `GET /sessions/:id/files` returns `summary.md`
7. Desktop Markdown tab renders it

### Scenario 2: Multi-repo research

1. Profile with `outputMode: artifact`, no `repoUrl`
2. `ap research <profile> "compare auth approaches" --repo github.com/org/frontend --repo github.com/org/backend`
3. Container has `/repos/frontend/` and `/repos/backend/` populated
4. Agent reads both repos, writes `comparison.md`
5. Session completes, artifact collected

### Scenario 3: Research with artifact push

1. Profile with `outputMode: artifact`, `repoUrl` set to a docs repo
2. `ap research <profile> "document our API surface"`
3. Agent writes structured docs to `/workspace/`
4. On completion: worktree checked out, artifacts copied in, `research/<id>` branch pushed
5. Branch visible in GitHub with the docs

### Scenario 4: Private reference repos

1. `--repo github.com/org/private-sdk --repo-pat ghp_xxx`
2. Container clones the private repo with PAT injected into auth URL
3. PAT stripped from git remote after clone
4. Agent can read the private repo without PAT being accessible

### Scenario 5: Failed reference repo clone

1. `--repo github.com/org/nonexistent --repo github.com/org/real`
2. First clone fails (404/403)
3. Warning logged, session continues
4. `/repos/real/` exists, `/repos/nonexistent/` does not
5. Agent proceeds (may note the missing repo in its output)

## Manual verification steps

1. Check `session.artifactsPath` is set on a completed artifact session via `GET /sessions/:id`
2. Verify `GET /sessions/:id/files` returns files for artifact sessions
3. Verify `GET /sessions/:id/files` still works for non-artifact sessions (regression)
4. Confirm profile validation rejects `outputMode: pr` with missing `repoUrl`
5. Confirm profile validation accepts `outputMode: artifact` with missing `repoUrl`

## Regression checks

- `ap run` (PR sessions) — unaffected
- `ap workspace` (workspace pods) — unaffected
- `GET /sessions/:id/files` for PR sessions with worktree — still reads from worktreePath
- Profile validation for existing PR profiles — repoUrl still required

## Edge cases to test

- Agent writes zero files to `/workspace/` — `extractDirectoryFromContainer` on empty dir
- Agent writes a binary file — files API serves it, desktop skips non-markdown in MarkdownTab
- `extractDirectoryFromContainer` called on already-removed container — error is caught, warning logged
- Artifact session killed mid-run — no `artifactsPath` set, files API returns 404 (not 500)
