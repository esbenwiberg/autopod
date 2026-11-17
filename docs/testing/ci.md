# Fast PR checks and full nightly validation

## Routine PR and branch checks

`CI / build-and-test` keeps the whole-workspace frozen install, lint, build and
existing typecheck commands, then runs `pnpm test:pr`. The secret scan remains a
separate check. This applies to PRs and pushes to `main` and `codex/reliability`.
There are no path filters on the required CI check. New commits cancel superseded
CI runs. The main job has a **5-minute timeout**, with a target of **3–4 minutes**
of runner execution; GitHub queue time and cold-cache timing are not guaranteed.

After installing dependencies and building, run the same test lane locally:

```bash
npx pnpm install --frozen-lockfile
npx pnpm build
npx pnpm lint
npx pnpm typecheck
npx pnpm test:pr
```

The PR test lane includes:

- The complete small-package suites (shared, CLI, validator, escalation MCP,
  mobile web and pi-worker); the e2e workspace currently only prints a placeholder.
- Ten explicitly listed daemon files in `scripts/test-pr.sh`: state-machine
  invariants, lifecycle regression runway, agent/validation workflows,
  infrastructure-result classification, composed lifecycle e2e, migration tests,
  API authentication, pod tokens and credential encryption.
- Root Node/script and deployment/cleanup fixture tests, portable Village host
  and renderer contracts, and renderer bundle consistency.

The daemon selection executes real migrated SQLite and mocked external boundaries.
It forces `SKIP_DB_TESTS=0`, keeps one worker, and verifies the JSON report against
the exact inventory. Missing, empty, skipped, todo, failed or accidentally expanded
selections fail the gate. Positional Vitest filters alone are not proof that every
selected file ran. Tests are not disabled in the ordinary full suite.

This is bounded smoke coverage, **not all daemon behavior or native macOS proof**.
Do not replace it with affected-package/related-test expansion: orchestration
changes can pull in the multi-minute `pod-manager.test.ts` file. When extending
the inventory, measure the complete lane and retain the time budget; do not add
retries or shorten existing per-test deadlines to make it green.

## Full runs

`Full Validation` runs daily at **03:17 UTC** on the default branch. GitHub may
delay scheduled runs. It is also manually dispatchable on a branch containing the
workflow, so risky changes can get full proof **before** merging:

```bash
gh workflow run full.yml --ref <branch>
```

Once this workflow has landed on the default branch, select it in Actions →
Full Validation → Run workflow, or use the command above. Rebase old branches
onto the workflow change before requesting full branch validation. Check the run's
recorded source SHA against the intended PR head; a green nightly on a different
SHA is not proof for that PR. No workflow was dispatched merely by adding this
configuration.

Full validation runs Linux and macOS independently, in parallel:

- **Linux:** frozen install, full-history secret scan, lint, build, typecheck,
  unfiltered `pnpm test` (all package and root script suites), and dependency audit.
  `TURBO_FORCE=true` forces real test execution even on an unchanged tree; it also
  rebuilds task dependencies deliberately. SQLite is required. The audit remains
  advisory, preserving prior CI policy; its output and exit status are retained,
  but audit errors do not fail the job.
- **macOS:** the existing isolated Swift test targets, Village contracts and
  unsigned Debug Xcode app build, through the reusable `Desktop` workflow.
  `Desktop` remains manually dispatchable for native-only validation. It no longer
  runs on every daemon/shared change or routine PR.

Linux has a 60-minute timeout and macOS 40 minutes. Full runs do not cancel an
in-progress full run. Their Turbo cache is separate from the small PR cache.
`pnpm test` and `scripts/validate.sh` remain full local validation commands.

“Full” means the configured offline suites, not provisioned live infrastructure:
opt-in Docker/Azure fixtures remain opt-in, the e2e workspace is still a placeholder,
and passing mock tests is not live-platform evidence. Inspect the reported skipped
counts. Linux never substitutes for Swift/AppKit/WebKit/Xcode validation.

## Failures and required checks

Full runs retain Linux test/build/typecheck/audit logs and native test/build logs
as Actions artifacts for 14 days. The Linux summary links coverage limitations;
raw test logs retain passed/skipped counts. Bash pipeline failures remain failures
even though output is also captured with `tee`.

A scheduled failure or incomplete job opens one `[CI] Nightly full validation failed`
issue assigned to `esbenwiberg`; repeated failures add the new run and source SHA to
that issue. The next fully successful nightly comments and closes it. The scheduled
reporting job alone gets issue-write permission; manually dispatched branch runs
use their Actions results and do not mutate the shared nightly issue. Triage the
failed job and restore green coverage before treating main as fully validated.

The existing `CI / build-and-test` and `CI / secret-scan` identities are retained.
If repository rules require `Desktop / test-and-build`, remove that routine PR
requirement when adopting this split, or merges will wait on a check that no longer
runs automatically. Workflow files do not change repository protection settings.

Local verification: a fresh (`TURBO_FORCE=true`) small-package test run plus daemon
smoke and script/renderer checks completed in about 121 seconds on the shared Linux
host: 1,860 Vitest tests and 92 Node tests, plus deployment/cleanup shell fixtures.
This is test-lane timing only, not hosted end-to-end or native validation.
