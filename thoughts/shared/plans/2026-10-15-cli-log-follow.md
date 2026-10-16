# R03a: report failed log streams accurately

## Overview and authorization

Make existing `logs --follow` commands distinguish an intentional Ctrl+C stop
from a failed subscription or disconnected stream. The user authorized the
campaign's autonomous RPI/review/proof workflow and said Go. The terminal output
proposal was shown in conversation before implementation. This changes no desktop
layout, introduces no command/option and makes no provider/container calls.

## Current State Analysis

See `thoughts/shared/research/2026-10-15-cli-log-follow.md`. Both command aliases
use logsAction in packages/cli/src/commands/pod.ts. Remote close always exits0,
top-level protocol errors are silently ignored, and the async command returns
before following ends. Daemon close4001 means missing/invalid authentication.
The generic CLI handler already maps AuthError to exit2 and other errors to1.

## Desired End State

- Ctrl+C intentionally ends following, removes listeners and exits0.
- Any unsolicited remote close, including1000/1006, exits1 with an actionable
  disconnect message. Close4001 uses AuthError and the existing exit2/login path.
- A top-level `{type:'error'}` protocol message fails once with exit1 even if the
  server leaves the socket open. Nested agent log errors remain ordinary output.
- Connection errors fail once; simultaneous error/close/SIGINT events cannot
  emit duplicate diagnostics, turn a prior failure into success, or leak handles.
- Existing banners, event formatting, reasoning option and command aliases remain
  intact. No automatic reconnection/replay is added in this bounded repair.

## Implementation approach

R01a must be integrated first; worker forks from that integration commit. Extract
the follow lifetime to a small helper under packages/cli/src/utils/log-follow.ts
if that makes ownership clearer; keep existing formatter in pod.ts and supply it
as a callback. logsAction awaits the lifetime, so existing top-level handling owns
the final process result. No process.exit calls inside socket/signal callbacks.

Create the socket with the existing bearer/token path and pod subscription.
One terminal outcome owns settlement. Register SIGINT and socket handlers before
events can arrive; remove only this helper's listeners. Stop/terminate the owned
socket on cancellation/protocol failure and keep an error listener until closure
so CONNECTING termination cannot produce an unhandled error. Settle on close with
the already-selected cause; a later event cannot replace it. Ensure a bounded
cleanup path if a graceful close would hang; termination is appropriate for this
read-only subscription. Do not add an application silence timeout in this task.
Explicitly catch open/send callback exceptions into that same settlement path.
The scope starts after token acquisition: do not redesign authentication
cancellation. HTTP handshake rejection remains a generic socket failure (exit1);
only protocol close4001 maps to AuthError, without matching error-message text.
Preserve follow's existing precedence over --build.

Protocol parsing retains existing malformed-frame tolerance. Recognize only the
top-level protocol error, without treating nested worker errors as transport
failure. Use bounded local diagnostic text rather than printing untrusted close
reason bytes. Proposed exact messages:

```
Error: Log stream disconnected (code 1006).
Run ap logs <resolved-id> --follow to reconnect.
```

Use the actual numeric close code and resolved ID. Authentication close:
`Log stream authentication failed.` via AuthError; the existing handler adds
`Try: ap login`. Protocol error: `Log stream subscription failed.` Generic socket
error keeps useful connection error context through the normal handler. Emit
diagnostics on stderr; preserve existing log output on stdout.

## Test and proof phases

### 1. Reproduce the failure on the old bundle

Extend the private executable fixture with an owned ws server and signal control.
Keep HTTP cases working and existing environment/close/cleanup guarantees intact.
Use actual upgrade/subscription events as barriers, not sleeps. Capture final
stdout/stderr and normal exit code through the real executable.
The child's signal method must not mark fixture cancellation or use SIGKILL;
normal SIGINT cases must have cancelled=false and failure=null. Teardown still
owns forced cleanup of children remaining after failed assertions.

Before changing production, run at least the abnormal-close case against a fresh
baseline bundle and record its wrong exit0; protocol-error case may reach the
harness watchdog, which is failure rather than product behavior success.

### 2. Implement and exercise final behavior

Use actual loopback WebSocket scenarios:

1. Receive exactly one authenticated subscription, send an ordinary status/error
   log event, observe it in child stdout, then terminate TCP: exit1, event retained,
   one disconnect diagnostic. Server send alone is not proof of receipt.
2. Server close1000: exit1 (no server end-of-stream contract exists).
3. Server close4001: exit2 and existing login suggestion, no duplicate failure.
4. Top-level protocol error with socket left open: exit1 and socket released.
5. Ctrl+C after subscription: normal exit0, no disconnect diagnostic, server sees
   closed connection. POSIX-only signal assertion is explicit if Windows differs.
6. Ctrl+C while HTTP upgrade is held: exit0 without unhandled WebSocket error.
7. Connection failure before open: exit1, one diagnostic, all owned resources close.

Cover both aliases and preserved --show-reasoning with a representative event;
do not duplicate the entire formatter's test matrix. Run the new suite through
the built CLI; focused helper tests may cover listener removal/outcome races if
real-process scenarios do not observe those specific properties. Explicitly prove
failure then SIGINT before close, SIGINT then error/close, and removal of only
owned listeners; normal subprocess exit alone cannot establish listener cleanup.

### 3. Validate, independently review and integrate

Node22/pnpm9.15.4 frozen install; fresh shared+CLI build; all CLI tests, package
and changed-test-source typechecks; scoped Biome; secret scan; git diff --check.
Independent reviewer reruns real-process cases on final head, assesses races and
preserved behavior, and reports prove-work verdict before PR creation. PR base is
codex/reliability; hosted checks must pass before integration. Retain pre-fix and
final-head evidence. No human manual check is required for these observable CLI
contracts; the actual terminal output is captured by the executable tests.

## Acceptance

- [x] Baseline abnormal close reproduced as wrong exit0.
- [x] Final drop/graceful/auth/protocol/connection failure codes/messages proven.
- [x] Ctrl+C works while connecting and after subscribing.
- [x] Aliases, normal log errors and reasoning formatting preserved.
- [x] No duplicate diagnostics, leaked signal handlers or socket resources.
- [x] Full CLI/relevant checks pass; independent review completed before PR.
- [x] Hosted checks and integrated result recorded.

## Compatibility and rollback

Scripts that previously treated a broken stream as success will now see nonzero;
that is the intended correction. The log protocol, auth mechanism, available
commands and ordinary log text remain compatible. No migration/dependency change.
Revert the bounded helper/command change to restore prior behavior if needed.

## Status

Root-prepared plan, independently reviewed by research_desktop with no blocking
findings. Deterministic output and race/listener proof details incorporated above.
R01a is integrated at ace8de29; implementation authorized under the user's standing
campaign instruction and Go. Scope excludes reconnect/replay, generic HTTP
deadlines and unrelated CLI commands.

## Implementation and local evidence — 2026-10-15

Worker branch: `codex/reliability-log-follow`, forked from
`74a5b2cfd4e8dfdd2534a6067609b19a9607b125`. Local implementation/proof phases
are complete. Independent review, PR hosted checks and integration remain pending
and are owned by the campaign root; no PR was created by this worker.

`utils/log-follow.ts` now owns the subscription lifetime and chooses the first
terminal cause, retaining its error listener until the socket closes. `pod.ts`
awaits that promise and leaves diagnostics/exit codes to the existing CLI handler.
The existing formatter, banner, flags, token acquisition and non-follow behavior
remain in the command. The executable fixture adds an owned loopback WS peer,
subscription/request/output barriers and normal signal delivery distinct from
fixture-forced cleanup. The three original HTTP executable tests are unchanged.

**Local prove-work verdict: PROVEN for the bounded CLI contract on macOS/Node22.**
This verdict does not claim hosted checks, Windows Ctrl+C, live daemon/provider
behavior, reconnection or independent review.

| Claim | Observable evidence | Result |
|---|---|---|
| Regression exists before repair | Fresh baseline bundle received `[error] Worker diagnostic` before TCP drop; new executable regression failed with actual exit0 versus expected1 | Proven |
| Disconnects fail accurately | Built executable close1006/1000 exit1 with exact reconnect stderr; close4001 exit2 with login suggestion | Proven |
| Protocol and handshake failures do not silently succeed | Peer sends top-level error and stays open: child exit1 and peer closes; HTTP403 handshake exits1 with exactly one socket diagnostic | Proven |
| Ctrl+C is intentional success | Real SIGINT after subscription and during held upgrade: normal exit0, no signal termination, no fixture cancellation/watchdog/error | Proven on POSIX |
| Existing output/flags remain | Both aliases; hidden/default and visible reasoning; nested worker error retained; follow still takes precedence over build | Proven |
| First outcome and ownership survive races | Focused fake-event tests for failure→SIGINT, SIGINT→error/close, owned-only listener removal, synchronous send/open throws and send callback failure | Proven |
| Test fixtures release resources | Child close barrier, peer closure before teardown for accepted streams, zero sockets/child timers, stopped server and removed private tree after disposal; original held-HTTP cleanup case still passes | Proven |

Commands ran using `npx -y -p node@22 -p pnpm@9.15.4 -c '<command>'`
(Node v22.23.3; pnpm9.15.4):

- `pnpm install --frozen-lockfile` — passed.
- `pnpm --filter @autopod/cli... build` — shared and CLI freshly built, passed.
- Before production edits: `pnpm --filter @autopod/cli exec vitest run src/commands/log-follow.test.ts --reporter=json --outputFile=../../.autopod-data/reliability/log-follow-before.json`
  — expected regression failure, actual exit0.
- `pnpm --filter @autopod/cli exec vitest run src/commands/log-follow.test.ts src/utils/log-follow.test.ts src/index.test.ts`
  — 3 files/17 tests passed.
- `pnpm --filter @autopod/cli exec vitest run --reporter=json --outputFile=../../.autopod-data/reliability/log-follow-suite.json`
  — all 38 files/325 tests passed.
- `pnpm --filter @autopod/cli typecheck` — passed.
- `pnpm --filter @autopod/cli exec tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --skipLibCheck src/commands/log-follow.test.ts src/utils/log-follow.test.ts src/index.test.ts`
  — passed, including the fixture/helper imports.
- `pnpm exec biome check packages/cli/src/utils/log-follow.ts packages/cli/src/utils/log-follow.test.ts packages/cli/src/commands/log-follow.test.ts packages/cli/src/test-utils/cli-executable.ts packages/cli/src/commands/pod.ts`
  — passed.
- `pnpm secret-scan` — passed with new source files staged for scanner visibility.
- `git diff --check` — passed.

Ignored evidence is retained in this worker's `.autopod-data/reliability/`:
`log-follow-before.json`, `log-follow-before.log`, `log-follow-development.log`,
`log-follow-suite.json`, `log-follow-validation.log`, `log-follow-secret-scan.log`.
Final revision is recorded in `log-follow-revision.txt` after commit; the root's
independent review must build and rerun executable proof at that revision.

No material plan mismatch. One validation invocation initially put reporter
options directly on `pnpm test`, which pnpm rejected before executing any tests;
the corrected `pnpm exec vitest run` command above completed successfully. No
manual user verification is asserted or required by this bounded plan.

## Independent review and integration

Coordinator reviewed the complete final source/test diff at
a5b46b981f0dea423ae73657fa9e586808abb60a with no actionable findings, then
rebuilt shared+CLI and independently reran all17 focused/executable tests.
`log-follow-independent.log` records that pass. Review completed before PR420.

https://github.com/esbenwiberg/autopod/pull/420 passed hosted build-and-test and
secret-scan (CI run38785361525), then merged only into codex/reliability at
20b7652b9a4984cd777ce7d1694d4add7d9716aa. Coordinator freshly rebuilt the
integrated branch and reran all17 cases successfully; evidence is
`.autopod-data/reliability/r03a-integrated.log`. Worker evidence is retained in
`.autopod-data/reliability/r03a/`.

Final verdict: PROVEN for the bounded behavior on local macOS and hosted Linux.
Windows signal cases remain explicitly skipped; no live daemon/provider or
reconnection claim.
