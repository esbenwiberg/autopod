# Contributing

## Branches And Commits

Use short, descriptive branch names, usually `feat/<topic>`, `fix/<topic>`, or
`docs/<topic>`. Commit messages should follow Conventional Commits:
`type(scope): subject`, for example `fix(daemon): preserve pod status transition`.

## Local Validation

Install dependencies with `npx pnpm install`. Before opening a PR, run the same
loop CI uses:

```bash
npx pnpm lint
npx pnpm build
npx pnpm typecheck
npx pnpm test
```

For a package-scoped test run, use `npx pnpm --filter <package> test`, for
example `npx pnpm --filter @autopod/daemon test`.

## Pull Requests

Keep PRs focused on one behavior or repo-maintenance concern. Include the
validation commands you ran and call out any skipped checks, Docker limitations,
or follow-up work. Worktrees do not always track remotes, so create PRs with an
explicit head branch: `gh pr create --head <branch>`.

## Tests And Specs

Unit tests are co-located with source files as `*.test.ts`. Daemon tests should
use `createTestDb()` and helpers from `packages/daemon/src/test-utils/`.
Feature planning specs live under `specs/<name>/` with `purpose.md`, `design.md`,
and one brief per pod.

## Local Hooks

This repo ships hooks under `.githooks/`. Enable them with:

```bash
git config core.hooksPath .githooks
```
