# R01a: prove the CLI executable boundary

## Overview and authorization

Create the smallest package-local harness that exercises the built CLI with
private synthetic configuration and an ephemeral loopback HTTP peer. The user
has authorized autonomous RPI tasks, independent review before PR, and worker
branches targeting `codex/reliability`. This task has no visible UI or product
behavior change. It implements the first bounded slice of R01.

Research: `thoughts/shared/research/2026-10-15-reliability-verification-seams.md`.

## Current behavior

CLI HTTP tests invoke Commander in-process. The actual binary loads home-based
configuration/authentication before parsing argv, and top-level failures control
the process exit. Existing tests therefore do not prove the bundle/config/auth/
stdout/exit path together. Direct package test execution does not rebuild it.

## Desired end state

A test starts the freshly built `packages/cli/dist/index.js` using the same Node
executable as the test process. It observes exactly one authenticated compact-list
request and verifies that stdout contains only the expected JSON and the process
exits normally with code zero. A separate fixture error proves nonzero exit and
the expected stderr message through the real top-level handler.

The harness must settle and clean up when assertions fail or a child stalls.
Forced watchdog termination is test failure, never a successful application exit.

## Scope

- Owned files: a co-located executable integration test under packages/cli/src,
  narrowly scoped test helper if warranted, and this plan's evidence section.
- Existing production CLI behavior remains the subject of the test. Do not add
  retry logic, timeouts, config options, dependencies or new commands here.
- No provider, Docker, real daemon, user configuration or real credential access.
- No claim that this task proves log-follow reconnects, product timeouts, or
  daemon internals. Those need later behavioral plans.

## Implementation phases

### 1. Private subprocess and fixture lifecycle

Create a parent-owned temporary directory for synthetic home, temporary files and
cwd. Configure only a loopback URL and known synthetic dev token. Construct an
explicit child environment containing only required platform/runtime values and
private HOME/USERPROFILE and TMPDIR/TMP/TEMP locations; exclude auth/provider,
proxy settings and NODE_OPTIONS. Preserve only required platform values such as
Windows SystemRoot, and invoke absolute process.execPath without relying on PATH.
A preliminary child probe must assert os.homedir(), os.tmpdir() and process.cwd()
are inside the owned temporary tree. If this fails, do not launch the CLI.

Bind HTTP on 127.0.0.1 port zero. Track accepted sockets, requests and child
handles. Register exit/error/close listeners immediately after spawn. Collect bounded
stdout/stderr separately; wait for close (streams finished), not merely exit,
before asserting complete output. Enforce a bounded watchdog. Use request/close
barriers instead of sleeps. Teardown owns timer cancellation, socket destruction,
server closure, termination/reaping of only the recorded child, then directory
removal. Handle spawn failures and partial setup as well as normal completion.

### 2. Real command outcomes

Success: invoke `ls --compact --json --limit 1`; assert one
`GET /pods?limit=1&compact=true`, synthetic bearer token, normal exit code zero,
no signal, and exact parsed stdout array. Capture stderr without assuming it is
empty: current spinner behavior must not accidentally change this task's scope.

Error: return HTTP 403 with Content-Type application/json and
`{"code":"FORBIDDEN","message":"Fixture denies pod listing"}`. Assert exactly one
authenticated request, normal exit code 2, no signal, empty stdout, and stderr
containing both `Error: Fixture denies pod listing` and
`You do not have permission for this action.` Additional spinner output on stderr
is allowed. These follow api/client.ts:1007 and utils/error-handler.ts:4–33.
Do not use 401 here: it introduces the separate retry path at client.ts:957.

Harness teardown: deliberately keep one response open after the request barrier,
then trigger cancellation through the helper's explicit cleanup path. Assert the
owned child is reaped, socket/server are closed and temporary directory is removed.
This is harness verification, not a claim that Autopod times out requests.

### 3. Independent verification and PR

Build the CLI and dependencies with Node 22/pnpm 9.15.4 before running the
subprocess test. Run the new test and existing CLI tests, relevant lint/typecheck,
and diff/secret checks. Avoid rerunning every unrelated package test.

An independent reviewer checks test isolation, cleanup races, exact executable
being launched, false-positive success paths, output bounds and scope. Repeat
the new scenarios independently against the final commit. Record commands,
revision and evidence limitations using prove-work. Only then push/open the task
PR with base `codex/reliability`; observe hosted checks before integration.

## Acceptance checklist

- [x] Fresh bundle executed under Node 22, with independent child process.
- [x] Synthetic home/temp/config/token and loopback-only fixture observed.
- [x] Expected request, JSON-only stdout and normal zero exit proven.
- [x] Real top-level error/nonzero exit behavior proven.
- [x] Failure cleanup reaps children and removes owned resources.
- [x] Existing CLI tests, relevant lint/typecheck and secret checks pass.
- [x] Independent plan review and final diff/proof review recorded.
- [x] Hosted checks observed for the final PR revision.

## Rollback and risk

The task adds tests/helpers only and can be reverted without a migration.
Primary risks are stale dist artifacts, inherited environment leaks, hanging
connections and listeners attached too late. Explicit build, environment
construction, bounded ownership and immediate listener registration address them.

## Status

Completed and integrated: independent reviewer rebuilt and reran the three real
executable scenarios on `8463781c22d9d8455e949c756b27f037d2c8f49b`, finding no
actionable issues. PR https://github.com/esbenwiberg/autopod/pull/417 passed hosted
build-and-test and secret-scan (run 38783243727), then merged only into
codex/reliability at `ace8de295139748f447f22c948a10128d0d8dc6c`. Coordinator rebuilt
shared+CLI and reran all three scenarios on that integration commit: passed.
Verdict **PROVEN** for the scoped real-executable and cleanup claims on local
macOS and hosted Linux; Windows remains unexecuted. Evidence retained under
integration `.autopod-data/reliability/r01a/` and `r01a-integrated.log`.

The following worker evidence preserves the implementation history.

Prepared from delegated research. Independent technical plan review by
research_cli completed on October 15. Its three clarifications (exact 403/exit 2
contract, platform-aware private environment probe, and close barrier before
output assertions) are incorporated above. Implementation and local verification
completed on October 15 in `codex/reliability-cli-proof`, based on
`980e0b8663e8c7096e85826f88b819f325ddb18c`. No user approval is required for routine
technical decisions under standing authorization.

## Execution and proof evidence

Changed only `packages/cli/src/index.test.ts`, its package-local helper
`packages/cli/src/test-utils/cli-executable.ts`, and this plan. The helper launches
the actual built entry point with `process.execPath`, privately probes the child
home/temp/cwd/runtime paths, owns its loopback peer and children, bounds captured
output, records watchdog failures separately from application exits, and waits
for child/pipe closure before returning results. Teardown is idempotent and
removes the fixture tree only after children and sockets are closed.

All commands below ran with the prefix
`npx -y -p node@22 -p pnpm@9.15.4 -c` in the worker checkout. The observed runtime
was Node `v22.23.3` and the package manager was pinned to pnpm `9.15.4`.

| Check | Command inside the pinned environment | Outcome |
|---|---|---|
| Frozen dependency setup | `pnpm install --frozen-lockfile` | Passed; lockfile unchanged |
| Fresh dependency and binary build | `pnpm --filter @autopod/cli... build` | Shared and CLI builds passed |
| Targeted executable proof | `pnpm --filter @autopod/cli exec vitest run src/index.test.ts` | 3 tests passed |
| Existing CLI regression suite | `pnpm --filter @autopod/cli test` | 36 files, 311 tests passed, including the new tests |
| Scoped lint/format | `pnpm exec biome check packages/cli/src/index.test.ts packages/cli/src/test-utils/cli-executable.ts` | Passed |
| Package typecheck | `pnpm --filter @autopod/cli typecheck` | Passed |
| Test-source typecheck | `pnpm --filter @autopod/cli exec tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --skipLibCheck src/index.test.ts` | Passed; explicitly includes the test excluded by normal package typecheck |
| Secret scan with new helper staged | `pnpm secret-scan` | Passed |

`git diff --check` also passed. The new tests observed exactly one authenticated
compact-list request in the success and 403 cases. Success returned the exact JSON
array on stdout, exit 0 and no signal. Denial returned empty stdout, the specified
stderr message/suggestion, exit 2 and no signal. The held-response case reached
its request barrier before explicit cleanup, observed cancellation separately
from success, and verified child closure, cleared watchdog, zero sockets, closed
server and removed temporary directory. Cleanup was exercised twice to verify
idempotence. No provider, Docker, real daemon or operator configuration was used.

Local implementation claims are **PROVEN** on macOS with Node 22. Overall task
status is **PARTIALLY PROVEN** pending independent final diff/proof review and
hosted checks for the final PR revision. Windows environment paths are supported
by the helper but were not exercised here; no cross-platform run is claimed.
The watchdog is test containment, not evidence of an application request timeout.
Log-follow recovery and other CLI commands remain outside this proof's scope.

Next action: the coordinator obtains independent review of the worker commit and
reruns the executable proof, then creates the PR targeting `codex/reliability`
and observes hosted checks before integration. This worker does not open the PR.
