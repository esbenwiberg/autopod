# Reliability worker CI routing implementation plan

## Overview

Enable the existing general and desktop checks for worker PRs into
`codex/reliability`, and include daemon/shared changes in desktop eligibility.
This is the first bounded infrastructure task, R00, of the reliability campaign.

## Authorization

The user approved a long-lived branch with worker branches, autonomous execution
by Codex and subagents, RPI per task, review before PR, and testing including real
pods. Their instruction to minimize involvement and preapproval for work kept on
the branch governs routine technical phase transitions. This plan introduces no
product UI changes and needs no wireframe. Independent plan/diff review remains
required. No human verification is represented as completed by an agent.

## Current State Analysis

Both workflows restrict push and PR base branches to main. Desktop filters omit
shared launch fixtures and daemon API changes. See the corresponding research
artifact, whose workflow files were read in full against baseline `1a089d1b`.

## Desired End State

- Pushes to main or codex/reliability remain eligible for general CI.
- PRs targeting either branch are eligible for general CI.
- Desktop has the same branch coverage and retains current paths while adding
  `packages/shared/**` and `packages/daemon/**` to both push and PR paths.
- Existing jobs, runners, permissions, concurrency, manual dispatch, and command
  bodies are unchanged.

## What We're NOT Doing

No branch-protection changes, deployment, dependency upgrades, new CI jobs,
runtime behavior changes, or UI changes. Broader contract fixtures belong to
separate tasks. A local matcher check does not prove GitHub ran a job.

## Implementation Approach

Worker branch `codex/reliability-ci-routing` forks from the published campaign
commit and targets `codex/reliability`. Change only the two workflow definitions
and this plan's execution/evidence section. Keep fixtures and production code
unchanged. The coordinator handles PR creation after independent review.

## Phase 1: Enable existing checks on the integration branch

### Changes Required

1. `.github/workflows/ci.yml`: add `codex/reliability` alongside `main` in both
   push and pull_request branches.
2. `.github/workflows/desktop.yml`: make the same additions and include
   shared/daemon paths in both path lists. Preserve all existing entries.

### Automated Verification

- [ ] Parse both YAML files with the installed `yaml` module; verify branch
  arrays, existing job definitions, desktop manual dispatch, and old path entries.
- [ ] Evaluate representative trigger cases: main/reliability pushes;
  main/reliability PR bases; unrelated branch excluded; shared fixture and daemon
  changes eligible for desktop; docs-only changes excluded from desktop.
- [ ] `git diff --check` passes and diff scope contains only intended files.
- [ ] Independent reviewer checks final workflow diff before PR creation.
- [ ] After PR creation, record which checks actually start and their outcomes.
  An unavailable/unstarted hosted check remains unproven, never silently green.

### Manual Verification

None required: configuration eligibility and hosted outcomes are observable by
tools. Human product/design judgment is not involved in this task.

## Testing Strategy

Use a temporary Node verification script with `createRequire` anchored at the CLI
package to load the existing YAML parser. Compare parsed jobs and other unaffected
workflow keys to the parent revision. Check branch/path matching for the explicit
cases above. Do not add a source-mirroring permanent unit test for this small YAML
change. Inspect actual PR checks through the normal repository tooling.

## Performance Considerations

Daemon/shared changes now request a macOS job. This intentionally increases
contract-change coverage; docs-only PRs still avoid that job.

## Migration Notes

No data migration. Reverting the small workflow commit restores prior routing.
Nothing is merged to main as part of this campaign task.

## References

- Research: `thoughts/shared/research/2026-10-15-reliability-ci-routing.md`
- Campaign request: October 15, 2026 conversation; all seven improvement areas.

## Execution and evidence

Independent technical plan review by `research_cli` completed on October 15:
ready for bounded execution, no blocking issues. Reviewer checked live filters,
GitHub branch/path semantics, unchanged job scope, rollback and proof boundaries.
This is technical review under the user's standing authorization, not an invented
human signoff. Implementation has not started.
