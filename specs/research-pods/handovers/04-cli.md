# Handover 04 — CLI: ap research command

## Status: COMPLETE

## What was done

Created `packages/cli/src/commands/research.ts` and registered it in `packages/cli/src/index.ts`.

## Files changed

| File | Change |
|------|--------|
| `packages/cli/src/commands/research.ts` | Created — `registerResearchCommands` function |
| `packages/cli/src/index.ts` | Added import + `registerResearchCommands(program, getClient)` call |

## Acceptance criteria status

- [x] `ap research my-profile "research topic"` creates a session with `outputMode: 'artifact'`
- [x] `--repo` is repeatable: `--repo url1 --repo url2` → two entries in `referenceRepos`
- [x] `--repo-pat token` sends `referenceRepoPat`
- [x] Created session ID and status printed on success
- [x] Reference repo mount paths shown in output when repos specified
- [x] `ap research --help` shows correct description and options
- [x] TypeScript build passes (`tsup` ESM build success in 12ms, no errors)

## Key implementation notes

- Modelled directly on `workspace.ts` — same `withSpinner` / `formatStatus` / `chalk` pattern
- `--repo` uses Commander's accumulator pattern for repeatability (identical to `--pim-group` in workspace)
- Mount paths are derived server-side; the CLI just renders `session.referenceRepos[].mountPath` if present
- No `--branch` flag — branch is auto-set to `research/<id>` by the daemon
