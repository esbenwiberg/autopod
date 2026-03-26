# Blueprint: Workspace Pod

## Goal

Add a `workspace` output mode that provisions an isolated Docker container (same image, network policy, and credential injection as regular pods) and keeps it running for interactive use — no agent, no validation, no PR. The CLI gains `ap workspace` to create one and `ap attach` to drop into it via `docker exec`. On session complete, the branch is auto-pushed so a subsequent worker pod can branch from it — enabling a `/prep` → `/exec` handoff pattern.

---

## Non-Goals

- No xterm.js / WebSocket PTY streaming — `docker exec` from the local CLI is the only access mechanism
- No ACI support — workspace pods are local-only
- No automated PR or merge at the end of the session
- No validation phase
- No changes to the existing `pr` or `artifact` output modes

---

## Acceptance Criteria

- [ ] `ap workspace <profile> [description]` creates a session with `outputMode: 'workspace'`; daemon returns 400 if `executionTarget !== 'local'`
- [ ] Workspace session provisions a container (same image/network/credentials path as agent sessions) and transitions `queued → provisioning → running`, then `processSession` returns — container stays alive
- [ ] `ap attach <id>` (short IDs supported) resolves the session, calls `docker exec -it autopod-<sessionId> bash` (falling back to `sh`), inherits stdin/stdout/stderr
- [ ] When `docker exec` exits (user types `exit`), `ap attach` calls `POST /sessions/:id/complete` and prints confirmation
- [ ] `ap ls` shows workspace sessions with status `running` while attached, `complete` after exit, `killed` if force-killed
- [ ] `ap kill <id>` works on workspace sessions (existing path: `running → killing → killed`)
- [ ] New `running → complete` transition allowed in `VALID_STATUS_TRANSITIONS` for workspace sessions (guarded in the API: only allowed when `outputMode === 'workspace'`)
- [ ] DB migration adds `output_mode` column to `sessions` table (defaults to `'pr'`)
- [ ] DB migration adds `base_branch` column to `sessions` table (defaults to `null`, meaning use `profile.defaultBranch`)
- [ ] `CreateSessionRequest` accepts optional `baseBranch` — worker pod can be created with `--base-branch feat/plan-auth` to branch from workspace pod's output
- [ ] On workspace session complete, daemon pushes the branch to origin (`git push origin HEAD`) before transitioning to `complete`
- [ ] `ap workspace` accepts `--branch <name>` to set an explicit branch name (for handoff to worker)
- [ ] `ap run` accepts `--base-branch <name>` to start a worker from a workspace pod's pushed branch

---

## Architecture

### Data flow

```
ap workspace <profile> [desc] --branch feat/plan-auth
  → POST /sessions  { outputMode: 'workspace', branch: 'feat/plan-auth' }
  → daemon validates executionTarget === 'local'
  → enqueueSession(id)
  → processSession detects outputMode === 'workspace'
     → provision container (same path as today)
     → transition running
     → return  ← no agent spawn
  → session stays running

ap attach <id>
  → GET /sessions/:id  (get containerId, validate outputMode/executionTarget)
  → spawn child_process: docker exec -it autopod-<sessionId> bash
  → stdio: 'inherit'  ← full PTY, Ctrl+C, etc.
  → on exit → POST /sessions/:id/complete
             → daemon: git push origin HEAD (worktree push)
             → transition running → complete

ap run <profile> "execute the plan" --base-branch feat/plan-auth
  → POST /sessions  { baseBranch: 'feat/plan-auth' }
  → worktreeManager.create({ baseBranch: 'feat/plan-auth' })
     → bare repo fetches feat/plan-auth from origin
     → worker branch cut from feat/plan-auth tip
  → worker sees plan files, produces PR
```

### Handoff pattern

```
main
  └── feat/plan-auth        ← workspace pod: /prep runs here, auto-pushed on complete
        └── autopod/abc123  ← worker pod: branches from feat/plan-auth, runs /exec → PR
```

### State machine additions (`constants.ts`)

```
running: [...existing, 'complete']   ← workspace-only path
```

The `complete` API endpoint guards this: rejects if `outputMode !== 'workspace'`.

### New/changed files (key pieces only)

```
packages/shared/src/
  types/actions.ts           OutputMode: add 'workspace'
  types/session.ts           Session: add outputMode, baseBranch fields
                             CreateSessionRequest: add outputMode?, baseBranch?
  constants.ts               VALID_STATUS_TRANSITIONS: running → complete

packages/daemon/src/
  db/migrations/012_output_mode.sql     ALTER TABLE sessions ADD COLUMN output_mode TEXT DEFAULT 'pr'
                                        ALTER TABLE sessions ADD COLUMN base_branch TEXT
  sessions/session-repository.ts        NewSession: add outputMode, baseBranch; rowToSession: map both
  sessions/session-manager.ts           createSession: store outputMode/baseBranch from request
                                        processSession: pass baseBranch override to worktreeManager.create()
                                                        early-return branch for 'workspace'
                                        completeSession(id): push branch, transition running→complete
  api/routes/sessions.ts               POST /sessions/:id/complete  (new endpoint)
                                        POST /sessions: validate workspace + local constraint

packages/cli/src/
  commands/workspace.ts                 new file: ap workspace + ap attach commands
  commands/session.ts                   ap run: add --base-branch option
  api/client.ts                         add completeSession(), pass baseBranch in createSession
  index.ts                              register workspace commands
```

---

## Milestones

### M1 — Shared types + DB migration

**Intent:** Add `outputMode` and `baseBranch` to the shared type system and DB schema so all packages compile.

**Files touched:**
- `packages/shared/src/types/actions.ts` — add `'workspace'` to `OutputMode`
- `packages/shared/src/types/session.ts` — add `outputMode: OutputMode` and `baseBranch: string | null` to `Session`; add both as optional to `CreateSessionRequest`
- `packages/shared/src/constants.ts` — add `'complete'` to `running`'s valid transitions
- `packages/daemon/src/db/migrations/012_output_mode.sql` — two `ALTER TABLE` statements: `output_mode TEXT NOT NULL DEFAULT 'pr'` and `base_branch TEXT`
- `packages/daemon/src/sessions/session-repository.ts` — `NewSession.outputMode` + `NewSession.baseBranch`; `rowToSession` maps both columns

**Verification:**
```bash
npx pnpm build
npx pnpm --filter @autopod/shared test
npx pnpm --filter @autopod/daemon test
```

---

### M2 — Daemon: workspace process path + complete endpoint

**Intent:** `processSession` skips agent/validation/PR when `outputMode === 'workspace'`. On complete, push branch. New `POST /sessions/:id/complete` endpoint.

**Files touched:**
- `packages/daemon/src/sessions/session-manager.ts`
  - `createSession`: store `outputMode` (`request.outputMode ?? profile.outputMode ?? 'pr'`) and `baseBranch` (`request.baseBranch ?? null`)
  - `processSession`: pass `baseBranch ?? profile.defaultBranch` to `worktreeManager.create()`; after `transition(session, 'running', ...)`, if `outputMode === 'workspace'` → `return` immediately
  - Add `completeSession(id)`: validates `outputMode === 'workspace'`; calls `worktreeManager` push equivalent (`git push origin HEAD` on the worktree path); transitions `running → complete` with `completedAt`
  - Expose `completeSession` on the `SessionManager` interface
- `packages/daemon/src/api/routes/sessions.ts`
  - `POST /sessions/:id/complete` — calls `sessionManager.completeSession(id)`, returns 204
  - `POST /sessions` — if `outputMode === 'workspace'` and resolved `executionTarget !== 'local'`, return 400

**Verification:**
```bash
npx pnpm --filter @autopod/daemon test
# Manually: create a workspace session, watch it reach 'running' without spawning an agent
```

---

### M3 — CLI: `ap workspace` + `ap attach` + `ap run --base-branch`

**Intent:** Two new commands plus `--base-branch` on `ap run`. `ap workspace` creates the session. `ap attach` does `docker exec -it` and marks complete on exit (triggering auto-push). `ap run --base-branch` starts a worker from the workspace's pushed branch.

**Files touched:**
- `packages/cli/src/commands/workspace.ts` (new file)
  ```
  ap workspace <profile> [description] [--branch <name>]
    → client.createSession({ profileName, task: description ?? 'Workspace session',
                             outputMode: 'workspace', branch: opts.branch })
    → print session id + hint: "ap attach <id> to enter"
    → print hint: "ap run <profile> <task> --base-branch <branch> to hand off to worker"

  ap attach <id>
    → client.getSession(resolvedId)
    → validate outputMode === 'workspace', executionTarget === 'local'
    → spawnSync('docker', ['exec', '-it', `autopod-${session.id}`, 'bash'], { stdio: 'inherit' })
      → on ENOENT: print "docker CLI not found on PATH"
      → on non-zero exit (bash not found): retry with 'sh'
    → client.completeSession(id)   ← daemon pushes branch here
    → print "Session complete. Branch pushed to origin."
  ```
- `packages/cli/src/commands/session.ts` — add `--base-branch <branch>` option to `ap run`; pass through to `createSession`
- `packages/cli/src/api/client.ts` — add `completeSession(id: string): Promise<void>`; pass `baseBranch` in `createSession`
- `packages/cli/src/index.ts` — import + register workspace commands

**Verification:**
```bash
npx pnpm build

# Workspace → worker handoff
ap workspace <profile> "plan auth redesign" --branch feat/plan-auth
ap attach <id>
# inside container: /prep → commits plan files
exit
# ap ls shows 'complete', branch pushed to origin

ap run <profile> "execute the plan in .plan/" --base-branch feat/plan-auth
# worker branches from feat/plan-auth, sees plan files, produces PR
```

---

## Risks & Unknowns

| Risk | Probe |
|------|-------|
| `running → complete` transition being used by non-workspace sessions | Guard in `completeSession`: throw if `session.outputMode !== 'workspace'`; state machine allows it but API gates it |
| `docker` CLI not on `$PATH` when `ap attach` runs | `spawnSync` returns `ENOENT` status — catch and print "docker CLI not found on PATH" |
| Container name format | Confirmed: `autopod-${config.sessionId}` (full UUID) in `docker-container-manager.ts:29` |
| `bash` not in all stack images | Fallback to `sh` on non-zero exit. Both present in existing Dockerfiles |
| Profile `outputMode` already exists — workspace sessions override at request time | `request.outputMode ?? profile.outputMode` precedence in `createSession` |
| `spawnSync` vs `spawn` for `docker exec` | `spawnSync` with `stdio: 'inherit'` — blocking is correct for an interactive terminal |
| `git push` fails if remote branch diverged or no upstream | Use `git push origin HEAD` (not `--force`); if it fails, surface the error but still transition to `complete` — user can push manually |
| bare repo only fetches `profile.defaultBranch` — worker won't find `feat/plan-auth` unless we also fetch it | `worktreeManager.create` already uses `baseBranch` as the refspec to fetch: `+refs/heads/${baseBranch}:refs/heads/${baseBranch}`. Passing `feat/plan-auth` as `baseBranch` will fetch it. Confirmed in `local-worktree-manager.ts:65-69` |

---

Next: `/probe 'M1 — shared types and DB migration'`
