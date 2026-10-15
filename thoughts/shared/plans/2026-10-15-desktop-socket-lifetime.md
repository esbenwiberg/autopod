# R04b: own desktop websocket connect/disconnect work

## Overview and authorization

Repair the existing event transport lifetime before pending-action presentation.
The user authorized autonomous reliability work, RPI stages, workers and branch
PRs. All phases below are authorized together. No layout or new feature changes;
the previously selected Inline direction remains unchanged.

## Current state

Research: ../research/2026-10-15-desktop-socket-lifetime.md. EventStream disconnect
reads a mutable socket property in a later Task after clearing/replacing it.
EventSocket leaves initial connection and backoff tasks unowned, can resume after
a suspended token provider despite disconnect, and can accept duplicate connect.
Existing decoder/REST tests do not open the production socket. A native loopback
WebSocket peer was successfully probed without external dependencies.

## Desired end state and scope

Explicit disconnect closes the captured socket and invalidates its pending work.
A replaced/disconnected socket cannot reconnect or deliver newly completed socket
callbacks. Repeated connect on an active lifetime creates no duplicate socket.
A deliberate subsequent connect and automatic reconnect still subscribe/replay.
EventStream ignores queued callbacks from its old connection and disconnects the
old actor, never the replacement. Prove resource closure at a real loopback peer.

Production scope: AutopodClient/EventSocket.swift and
AutopodDesktop/Stores/EventStream.swift, plus a small internal socket adapter seam
if necessary; co-located Tests/AutopodClientTests fixtures/tests. Do not change
PodStore REST merging, action handlers, drafts, protocol payloads, backoff policy,
heartbeat intervals, authentication selection or connected-state definition.
Already-started REST refreshes are not fully connection-fenced by this task; do
not claim full daemon-switch isolation. No live app/bootstrap/account access.

## Phase1: reproducible boundaries

Build a bounded, concurrency-safe native loopback peer using Foundation/Network
(the research probe is scaffolding, not production-ready test code). Bind only
127.0.0.1 on an ephemeral port. Track accepted peers, frames, close/cancel events,
listener lifetime and every owned task. Use synthetic tokens, no home/defaults.
Provide awaited barriers with failure deadlines, release continuations on every
failure path, cancel peers/listener and await their cancellation during teardown.
No blocking semaphore on MainActor. An ephemeral injected URLSession may be added
as a defaulted initializer dependency; it must be invalidated by its test owner.

Run baseline regressions before ownership edits:
1. Hold existing tokenProvider, call connect then disconnect, release provider;
   no socket/connected callback should be produced after explicit disconnect.
2. Establish real subscription, close the peer to enter reconnect/backoff, then
   explicitly disconnect; no replacement connection after the backoff deadline.
3. Connect twice while active; only one peer/subscription should exist.
4. On the same EventSocket actor, hold token request A, disconnect, establish a
   new lifetime B, then release A. B must retain its peer and event delivery; no
   third peer or stale connected callback may appear.
5. EventStream replacement disconnects the captured old socket and preserves new
   socket; queued old event/state/resync callbacks must be ignored after replacement.

For case5 use a minimal internal Sendable socket protocol plus factory injectable
in an internal initializer, with EventSocket as the default adapter. Keep the
existing public initializer behavior/API. The controlled actor records exact
connect/disconnect/subscription operations and holds/delivers callbacks to expose
the MainActor queue race. Do not add a general transport framework. Actual
EventSocket transport closure is separately established by cases1–3/phase2.
If baseline behavior differs, report evidence before revising the plan.

## Phase2: owned task and identity repair

EventSocket retains its connection/backoff Task (one owned slot or two explicit
slots), cancels it on disconnect, and invalidates an attempt/lifetime generation.
Check cancellation and current generation after token acquisition, receive and
backoff awaits, before publishing callbacks, scheduling reconnect or creating a
socket. A receive/heartbeat callback from an old socket must not cancel/replace
the current one. Existing subscribe/replay and lastEventId behavior are preserved.
Public connect also checks cancellation at its actor entry: a cancelled
EventStream start Task must not spawn fresh unstructured work after its actor hop.
Public connect is idempotent while connecting/connected/reconnecting; an explicit
connect after disconnect remains supported. Do not rely on cancellation alone:
token providers may finish late even after their task is cancelled.

EventStream captures its old socket before clearing it, owns/cancels its queued
connection-start task and invalidates a local connection generation synchronously.
Its event/state/resync callbacks check their captured generation on MainActor
before dispatch. Queued subscribe/unsubscribe work captures intended socket and
checks current generation instead of reading a future replacement. Maintain
existing flush/history behavior; do not erase confirmed data merely to hide races.

Add final compatibility cases: current peer delivers a normal event and replay
truncation callback; automatic reconnect subscribes and sends the observed event
ID for replay; explicit reconnect after disconnect works; old callback delivery
cannot affect the replacement stream/store or invoke a resync fetch. Verify close
at the actual peer and no extra peer after bounded backoff observation. Negative
observation windows are evidence bounds, not a claim of infinite future behavior;
combine them with deterministic task/generation assertions. Avoid sleeps as the
ordering mechanism; use barriers, and document any intentional time window.

## Phase3: validation, review and integration

Run focused lifetime/decoder/resync/dedupe and R04a confirmed-action tests, then
full Swift suite and AutopodDesktopExe build. Run secret scan/diffcheck. Record
baseline failures and final revision, native peer close/teardown outcomes, counts
and existing skips. No screenshot is required for a transport-only claim; no UI
layout/status wording changes are authorized here.

Independent review must inspect task lifetime/identity checks and rerun the real
peer cases before PR. Target codex/reliability, await hosted tests/Xcode build,
then merge and rerun affected integration tests. No manual user verification is
needed for this isolated transport contract. Full-app behavior remains unproven.

## Acceptance

- [ ] Baseline ownership failures reproduced without external services.
- [ ] Disconnect cancels/fences pending connect and reconnect work.
- [ ] Active duplicate connect is harmless; current reconnect/replay still works.
- [ ] EventStream closes captured old socket and rejects its queued callbacks.
- [ ] Owned peer/session/tasks close on success and failure; full validation passes.
- [ ] Independent pre-PR, hosted and integrated proof recorded.

## Compatibility, performance, rollback

No protocol/schema/dependency change. An optional URLSession injection defaults to
current shared behavior. Internal factory is a testing seam, not a plugin API.
Reconnect delays and heartbeat settings stay unchanged. Reverting restores the
ownership defects; no production deployment is part of this task.

## Status

Resolved coordinator plan based on full source inspection and native peer probe.
Independent technical review precedes worker implementation. No open product
choices; report a scope mismatch before changing unrelated connection semantics.

## Independent plan review

research_cli identified a missing overlapping-lifetime proof: late token requestA
after new lifetimeB is established on the same actor. Added case4 above, and
explicit cancellation at public connect actor entry. Existing resync work already
inside REST remains outside the task's cancellation claim. These technical
clarifications preserve scope; root resolved them before worker execution.
