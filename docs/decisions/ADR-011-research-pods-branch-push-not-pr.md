# ADR 003: Branch push (not PR) for repo artifact delivery

## Context

Regular sessions push a branch and create a PR through the full validation pipeline
(build → smoke → AI review). Research artifacts are not code — running build/smoke tests
against MD files is meaningless.

## Decision

When `profile.repoUrl` is set for an artifact session: push branch `research/<sessionId>` only.
No PR creation. No validation.

## Consequences

- Users browse artifacts in GitHub/ADO via the branch directly
- No automated merge — intentional (research artifacts shouldn't auto-merge to main)
- Reuses `worktreeManager` push path; skips the PR manager entirely
- Consistent with workspace pod behavior (also branch-push only)
