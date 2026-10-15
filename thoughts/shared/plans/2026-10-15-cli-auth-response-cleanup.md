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

- [ ] Baseline unfinished401 ownership reproduced or plan reassessed with evidence.
- [ ] Real retry releases first stream and completes normally without watchdog.
- [ ] Retry count, request/auth semantics and final errors remain unchanged.
- [ ] Refresh failure and body cancellation edge cases retain correct ownership.
- [ ] Full CLI/relevant checks pass and independent pre-PR review completed.
- [ ] Hosted and integrated result recorded.

## Compatibility and rollback

No migration/API/dependency change. Cancelling a rejected response may close its
HTTP connection; the retry uses transport-managed connection establishment. This
releases a resource that no caller consumes. Revert the bounded cancellation to
restore prior behavior if needed. This task establishes resource ownership, not
a total request deadline or server-side operation cancellation.

## Status

Root-prepared resolved plan based on source. Ready for bounded worker execution
under standing campaign authorization, with baseline mismatch gate above.
