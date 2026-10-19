# R03b: release rejected authentication response before retry

## Overview and authorization

The generic CLI HTTP client retries once after401 but leaves the first response
body unconsumed. Close that response resource before the existing retry. This is
a bounded transport ownership repair under the autonomous reliability campaign.
No commands, diagnostics, credentials, flags or timeout policy change. All phases
authorized together; no visible UI change or manual user check.

## Current behavior

See research/2026-10-15-cli-http-lifetime.md. In
packages/cli/src/api/client.ts request, first401 is overwritten by retry response
without consuming/cancelling its body. The executable fixture uses a real built
CLI, private token/config/home, loopback server, bounded output/child cleanup.

## Desired behavior and scope

Before refreshing the token or issuing the one existing401 retry, cancel the
first rejected response body if present. Await cancellation. A body already closed
or errored must not prevent the existing auth retry; handle cancellation failure
locally without changing auth/network classification. Never read an unbounded401
body merely to drain it. Preserve the one-retry limit, request method/path/body,
bearer-token acquisition behavior and final HTTP status mapping.

Change only generic request's401 ownership, tests and narrowly required test
fixture functionality. Do not change updateFromBase, managed transport, auth
policy, mutation retry rules, error text or timeouts. These have separate semantics.

## Phase1: reproduce resource lifetime

Extend the existing private executable fixture with controlled per-request HTTP
responses sufficient for one unfinished401 followed by a normal list response.
Track each owned request/socket and explicit first-response close. The first
response sends401 headers plus an unfinished body and remains open. Observe the
second request; its successful response is gated on the first response closing.
Use receipt/close barriers and the existing watchdog, no arbitrary sleep ordering.

Run against a fresh baseline bundle before production edits. Record whether the
first body remains live until forced fixture cleanup and the executable cannot
finish the gated journey. Watchdog is failure evidence, not a product timeout.
If the installed transport already disposes the first body, report evidence and
reassess instead of forcing an artificial failure. Teardown releases all held
responses, reaps children and removes private files on every failure path.

## Phase2: repair and prove

Add the bounded cancellation in request. Real executable success case proves
first401 stream closes, exactly two authenticated list requests occur with
identical query, normal JSON stdout/exit0 and no watchdog/forced cancellation.
Preserve existing executable HTTP/log-follow suites.

Focused client tests cover cancel-before-refresh/retry ordering, absent body,
cancellation rejection still allowing existing retry, and second401 causing the
existing auth error with no third request. Also prove the rejected body is
released when token refresh fails. Tests must use actual Response body behavior
or a realistic controlled body, not simply duplicate implementation branches.

## Phase3: review/integrate

Use explicit Node22/pnpm9.15.4, frozen install, fresh shared+CLI build; full CLI
tests, package and changed-test typechecks, scoped Biome, secret scan and diffcheck.
Independent review of final diff plus executable rerun before PR. Target only
codex/reliability; hosted checks must pass, followed by integrated executable
proof. Record pre-fix and final revision evidence and cleanup outcomes.

## Acceptance

- [x] Baseline unfinished401 ownership reproduced or plan reassessed with evidence.
- [x] Real retry releases first stream and completes normally without watchdog.
- [x] Retry count, request/auth semantics and final errors remain unchanged.
- [x] Refresh failure and body cancellation edge cases retain correct ownership.
- [x] Full CLI/relevant checks pass and independent pre-PR review completed.
- [x] Hosted and integrated result recorded.

## Compatibility and rollback

No migration/API/dependency change. Cancelling a rejected response may close its
HTTP connection; the retry uses transport-managed connection establishment. This
releases a resource that no caller consumes. Revert the bounded cancellation to
restore prior behavior if needed. This task establishes resource ownership, not
a total request deadline or server-side operation cancellation.

## Status

Root-prepared resolved plan based on source. Ready for bounded worker execution
under standing campaign authorization, with baseline mismatch gate above.

## Implementation and local proof — 2026-10-15

Worker `codex/reliability-cli-auth-cleanup` started from
`4e79fedc2f4ee98b6e2ffa7ed5906b3133eef3ce`. Production changes are five lines
inside generic request's first401 branch: await body cancellation when present,
ignore cancellation rejection locally, then execute the unchanged refresh/retry.
The separate updateFromBase path is unchanged.

**Local prove-work verdict: PROVEN for this bounded response-ownership contract.**
Independent pre-PR review, hosted checks and integration remain pending with root.
No live daemon/provider, new deadline policy or server-side cancellation is claimed.

| Claim | Evidence | Result |
|---|---|---|
| Baseline leaves unfinished401 open while retrying | Fresh baseline executable reached second request; successful response gated on first response close could not finish; fixture watchdog killed child after10s | Reproduced before production edit |
| Retry now releases the discarded stream | Real executable's first unfinished401 closes; gated second response completes with exit0, JSON `[]`, exactly two identical authenticated list requests and no watchdog/cancellation | Proven |
| Cancellation finishes before refresh/retry | Actual Response/ReadableStream with deferred cancel hook; mutation request remains unchanged except refreshed bearer token | Proven |
| Existing body/error behavior survives | Actual absent, closed, errored and cancellation-rejecting bodies; refresh failure after release; second401 produces existing AuthError without third request | Proven |
| Resources are owned | Explicit response-close barrier plus existing child-close teardown; server stopped, no sockets/child timers, private directory removed in finally | Proven |

All commands used `npx -y -p node@22 -p pnpm@9.15.4 -c '<command>'`
(Node v22.23.3, pnpm9.15.4):

- `pnpm install --frozen-lockfile` — passed.
- `pnpm --filter @autopod/cli... build` — fresh shared and CLI builds passed,
  both before baseline reproduction and after the production repair.
- Baseline: `pnpm --filter @autopod/cli exec vitest run src/index.test.ts -t "unfinished 401" --reporter=json --outputFile=../../.autopod-data/reliability/auth-cleanup-before.json`
  — expected failure on non-null fixture-watchdog result; this is not a product timeout.
- `pnpm --filter @autopod/cli exec vitest run --reporter=json --outputFile=../../.autopod-data/reliability/auth-cleanup-suite.json`
  — 39 files/333 tests passed, including original HTTP and log-follow executable tests.
- `pnpm --filter @autopod/cli typecheck` — passed.
- `pnpm --filter @autopod/cli exec tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --skipLibCheck src/api/client-auth-retry.test.ts src/index.test.ts`
  — changed test sources and their fixture/client imports passed.
- `pnpm exec biome check packages/cli/src/api/client.ts packages/cli/src/api/client-auth-retry.test.ts packages/cli/src/index.test.ts packages/cli/src/test-utils/cli-executable.ts`
  — passed.
- `pnpm secret-scan` and `git diff --check` — passed.

Implementation detail: the focused cases live in the co-located
`api/client-auth-retry.test.ts`. An initial explicit typecheck of the existing
`api/client.test.ts` found its unrelated, pre-existing line444 series fixture uses
`profile`, which is no longer a SeriesLaunchRequest field (TS2353). That original
file was restored unchanged; its runtime tests still pass in the full suite.
No broader test-source typecheck success is claimed. No material plan mismatch.

Ignored evidence lives under this worker's `.autopod-data/reliability/`:
`auth-cleanup-before.json`, `auth-cleanup-before.log`,
`auth-cleanup-development.log`, `auth-cleanup-suite.json`,
`auth-cleanup-validation.log` (initial existing-test TS2353), and
`auth-cleanup-validation-final.log` (all scoped checks passed).
The committed revision and final focused rerun are recorded after commit in
`auth-cleanup-revision.txt`, `auth-cleanup-final.json`, `auth-cleanup-final.log`.

## Final integration proof

PROVEN for the bounded response-ownership contract at worker
dbe28efaed65c3a8350125d5b34410cc1c3fe844. Coordinator independently reviewed
the full production change, new tests and executable fixture, then freshly built
and ran18 focused retry/HTTP/lifetime cases before opening PR422. An additional
seven log-follow executable cases passed on the same source. Hosted CI38787912870
passed. PR422 merged at913c0622; fresh integrated CLI build and all25 affected
cases passed (r03b-integrated.log). Original before/after/full-suite and independent
evidence retained in .autopod-data/reliability/r03b/. No new timeout or live-daemon
claim; the existing unrelated test-source type error remains documented above.
