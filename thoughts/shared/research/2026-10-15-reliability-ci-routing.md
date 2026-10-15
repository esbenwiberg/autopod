---
date: 2026-10-15T19:27:43+02:00
researcher: Codex
git_commit: 1a089d1b83f660e7bef49089d458ead0f49c0553
branch: codex/reliability
repository: autopod
topic: "Workflow eligibility for reliability worker pull requests"
tags: [research, codebase, ci]
status: complete
last_updated: 2026-10-15
last_updated_by: Codex
---

# Research: reliability branch CI routing

## Research Question

Which workflow definitions currently match worker PRs into the requested
long-lived reliability branch and daemon/shared contract changes?

## Summary

General and desktop workflow push and pull_request branch filters contain
only `main`. Desktop additionally filters changed paths. A PR with base
`codex/reliability` does not match either declared branch filter.

## Detailed Findings

- `.github/workflows/ci.yml:3-7`: push and pull_request both list `[main]`.
  Jobs build/test on Node 22 and scan secrets. Audit is non-blocking.
- `.github/workflows/desktop.yml:3-18`: manual dispatch is supported;
  push/PR require main plus a matching desktop/workflow/renderer/lockfile path.
- Desktop job runs Swift tests, renderer tests, and an unsigned Xcode build.
- `packages/shared/src/fixtures/composable-launch.json` is read by
  `packages/desktop/Tests/AutopodClientTests/LaunchConfigurationTests.swift:63`.
  Its path is outside the desktop workflow's current filters.
- `packages/cli/package.json` already depends on `yaml`; the installed module
  can parse workflow definitions during local verification without adding a
  project dependency.

## Architecture Documentation

The two workflow files are independent. General CI has no path filter;
desktop CI combines branch and path eligibility. These definitions do not
establish the repository's external branch-protection settings.

## Open Questions

None for workflow-file routing. Hosted execution and external branch protection
are separate observations, not claims established by parsing these files.
