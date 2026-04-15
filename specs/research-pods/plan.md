# Research Pods — Plan

## Problem

`outputMode: 'artifact'` exists in the type system and has scaffolding in
`system-instructions-generator.ts` (lines 161-182, 346-358, 500-515), but is completely
unhooked in `session-manager.ts`. There is no way to run an agent that:

- Has no primary repo (pure web research)
- Reads from multiple repos without write access
- Produces MD files / reports as its deliverable instead of a PR

## Goals

1. Fully implement `artifact` output mode end-to-end
2. Support zero or N read-only reference repos cloned into the container at `/repos/<name>/`
3. Collect all of `/workspace/` as artifacts on completion
4. Deliver via two modes (configured by whether `profile.repoUrl` is set):
   - **API** — files served via existing `GET /sessions/:id/files` endpoint; browsable in desktop
   - **Repo** — push branch `research/<session-id>` to `profile.repoUrl`
5. CLI: `ap research <profile> <task> [--repo <url>]... [--repo-pat <token>]`
6. Desktop: artifacts visible in existing Markdown tab without new components

## Architecture

### Artifact mode vs workspace mode

| | workspace | artifact |
|---|---|---|
| Agent spawned | no | **yes** |
| Primary repo (worktree) | required | optional |
| Worktree mounted in container | yes | **no** |
| Reference repos | no | yes (`/repos/<name>/`) |
| Completion | branch push | extract + branch push OR api-only |
| Validation | skipped | skipped |
| PR created | no | no |

### Provisioning flow (artifact mode)

```
queued → provisioning:
  1. If profile.repoUrl set: create worktree (artifact destination, NOT mounted in container)
  2. Spawn container (no worktree volume — agent has no git write access)
  3. Clone each referenceRepo into container: git clone --depth 1 <url> /repos/<name>/
  4. Inject provider credentials + system instructions (artifact-mode variant)
  5. Spawn agent → running
```

### Completion flow (artifact mode)

```
running → complete:
  1. extractDirectoryFromContainer('/workspace', artifactsPath)
  2. Store artifactsPath on session
  3a. If profile.repoUrl set: copy artifacts into worktree → auto-commit → push branch research/<session-id>
  3b. If no profile.repoUrl: store at <dataDir>/artifacts/<session-id>/, serve via files API
```

### Files API

`GET /sessions/:id/files` already exists (`daemon/src/api/routes/files.ts`). Change: when
`session.worktreePath` is null, fall back to `session.artifactsPath`. Desktop's MarkdownTab
uses this route via `loadFiles`/`loadContent` callbacks — no desktop code changes needed
beyond showing Markdown tab by default for artifact sessions.

## Dependency Graph

```
Brief 01 (types + schema)
    ↓
Brief 02 (daemon provisioning)    Brief 04 (CLI)
    ↓
Brief 03 (daemon completion)
    ↓
Brief 05 (desktop)
```

Brief 04 (CLI) depends on Brief 01 types but can proceed in parallel with Brief 02.

## Key Risks

- **Reference repo clone failures** — network issues or private repos without PAT should be
  non-fatal: log a warning, continue without that repo. Agent gets a note in system
  instructions about which repos failed.
- **Large `/workspace/` extraction** — `extractDirectoryFromContainer` tars the entire
  `/workspace/`. If the agent downloads large files, this can be slow. Mitigate: document
  a 500MB soft limit in system instructions.
- **profile.repoUrl nullable** — making it optional is a type-level change only; existing
  profiles all have it. Profile validator must allow null/absent only when `outputMode === 'artifact'`.
- **Files API ambiguity** — for repo-delivery artifact sessions, `worktreePath` exists AND
  `artifactsPath` exists (same content). `files.ts` should prefer `worktreePath` when set.
