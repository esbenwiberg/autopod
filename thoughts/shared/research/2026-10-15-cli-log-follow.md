# CLI log-follow lifetime and failures

Date: 2026-10-15. Source: campaign `28ed9a0f` (CLI production source unchanged
from `1a089d1b`). RPI research for R03a. Root read commands/pod.ts in full,
daemon api/websocket.ts, CLI entry/error handler, ID resolver and remote terminal.

`packages/cli/src/commands/pod.ts:664` implements log following inline. Both
`ap logs` and `ap pod logs` invoke that function. It resolves abbreviated IDs,
fetches a token and opens the daemon /events WebSocket with bearer auth.

On open it sends a pod subscription and prints the Following banner. Message
handling ignores subscribed/unsubscribed acknowledgements and top-level error
messages. Other JSON messages reach the existing formatter; parse/format errors
are ignored. Nested agent_activity events with event.type=error are ordinary log
content, distinct from top-level protocol errors.
Follow takes precedence over --build, and pod.completed is displayed data rather
than a stop condition.

Every remote close currently calls process.exit(0), including code 4001 and
abnormal termination. Socket errors print to stderr and exit one. A global SIGINT
handler closes the socket and exits zero. The command returns before the socket
lifetime completes, so the top-level async error handler cannot own these failures.

`packages/daemon/src/api/websocket.ts:96` closes 4001 for absent or invalid tokens.
Its top-level error message at line 158 is a protocol error and need not be followed
by socket closure. There is no terminal stream-completion protocol: a pod.completed
event is data, and the server keeps the subscription open. Thus remote close1000
does not prove a complete log-follow session either.

`packages/cli/src/utils/error-handler.ts` maps AuthError/AUTH_ERROR to exit2 plus
the existing ap login suggestion. Generic errors exit1. `src/index.ts:70` awaits
Commander parseAsync and routes rejected command promises to that handler.
`utils/id-resolver.ts:14` accepts full IDs without an initial HTTP list call.

Remote terminal uses a separate lifecycle helper with idempotent cleanup. Its
remote exit:N protocol is specific to terminals and is not used by /events.

The new R01a worker at `8463781c` supplies actual CLI child-process tests with
synthetic config/auth and explicit cleanup. The current integration does not
yet contain it. Its parent owns an ephemeral HTTP server and raw TCP sockets;
log-follow tests will additionally need an owned WebSocket server and protocol
barriers. Existing ws is already a CLI dependency; no new package is needed.

Research boundary: source inspection establishes current paths. No new regression
test has run yet for log-follow failure behavior. Current code is not evidence
that a proposed replacement handles close/error/SIGINT races correctly.
