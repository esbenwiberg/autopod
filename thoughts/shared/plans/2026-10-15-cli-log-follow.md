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

- [ ] Baseline abnormal close reproduced as wrong exit0.
- [ ] Final drop/graceful/auth/protocol/connection failure codes/messages proven.
- [ ] Ctrl+C works while connecting and after subscribing.
- [ ] Aliases, normal log errors and reasoning formatting preserved.
- [ ] No duplicate diagnostics, leaked signal handlers or socket resources.
- [ ] Full CLI/relevant checks pass; independent review completed before PR.
- [ ] Hosted checks and integrated result recorded.

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
