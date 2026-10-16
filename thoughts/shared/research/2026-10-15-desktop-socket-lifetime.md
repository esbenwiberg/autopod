---
date: 2026-10-15T20:49:18.614781+02:00
researcher: Codex
git_commit: 2c23df03fae7f63fc3dbf665c560d100395acd55
branch: codex/reliability
repository: autopod
topic: "Desktop websocket task ownership across disconnect and reconnect"
status: complete
last_updated: 2026-10-15
last_updated_by: Codex
---

# Desktop socket lifetime

## Current ownership

EventStream.disconnect schedules a MainActor Task that later reads eventSocket,
then synchronously sets that property to nil. Plain disconnect leaves the deferred
Task reading nil. connect calls disconnect and synchronously installs a replacement;
the deferred disconnect can therefore target that replacement. Callbacks queue
MainActor Tasks with weak self and no generation. Event callbacks mutate PodStore
and buffered events when delivered. Both app entry points replace EventStream but
retain PodStore; other async stream work can retain the old stream. See
packages/desktop/Sources/AutopodDesktop/Stores/EventStream.swift:77–112,209,363 and
packages/desktop/Autopod/AutopodXcodeApp.swift:53,87. Root read the entire stream.

EventSocket.connect retains no handle for doConnect, and its guard rejects only
connecting. doConnect awaits token acquisition, then opens a websocket without a
cancellation/attempt check. disconnect cancels receive/heartbeat/socket but cannot
cancel untracked initial-connect/backoff Tasks. The receive loop checks cancellation
before receive, not after it or against socket identity. Backoff calls doConnect
without checking explicit disconnect. Connected currently means socket resumed,
not server handshake confirmed. See AutopodClient/EventSocket.swift:65–211; root
read the entire actor. These are source-derived paths; production failure has not
yet been reproduced by this research.

## Existing tests and dependencies

EventSocketControlMessageTests exercises replay_truncated decoding only.
EventStreamResyncTests invokes REST resync directly through an injected URLProtocol;
EventStreamDedupeTests exercises static array merges. The opt-in live test reads
real auth and does not assert transport closure. EventSocket hardcodes shared
URLSession; tokenProvider is an existing deterministic suspension point.

## Executed transport feasibility

Agent research_desktop compiled and executed an ignored standalone Swift probe
using Foundation/Network only: NWListener, required loopback endpoint127.0.0.1,
NWProtocolWebSocket handshake, real URLSessionWebSocketTask. The server received
subscribe_all, the client received subscribed_all, and the server observed normal
close. Exit0 on Swift6.3.3. Source/log are retained in
.autopod-data/reliability/event-socket-research/loopback-probe.{swift,log}.
No account, config, credentials or external service was accessed. This establishes
fixture interoperability only. Native CI runs Swift tests before setup-node, so
the probe uses dependencies already present in that phase.

## Open questions

None for source ownership or loopback feasibility. Baseline regression outcomes
and an implementation belong to a separate resolved task plan. No full-app,
connection-scope REST isolation, handshake-state or draft behavior is proven here.
