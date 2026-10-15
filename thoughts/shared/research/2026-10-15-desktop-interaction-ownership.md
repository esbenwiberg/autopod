---
date: 2026-10-15T20:46:39.565564+02:00
researcher: Codex
git_commit: 913c0622
branch: codex/reliability
repository: autopod
topic: "Current desktop action, draft, connection and decision lifetimes"
status: complete
last_updated: 2026-10-15
last_updated_by: Codex
---

# Desktop interaction ownership

## Question and scope

What existing state can support reliable pending actions and retained replies
under the user-selected Inline direction? Research only; no UI implementation.
Agent research_desktop inspected the current paths, and the coordinator verified
application wiring, PodStore, action ownership, event dispatch and reply acceptance.
R04a's confirmed Pause/Kill correction is already integrated.

## Current lifetimes

Both application entry points own PodStore in app-level @State. Their
wireUpConnection methods configure that store and create a new ActionHandler and
EventStream. Disconnection disconnects/removes EventStream but retains the store
and action handler. The Xcode and SwiftPM entry points are
packages/desktop/Autopod/AutopodXcodeApp.swift:12,87 and
packages/desktop/Sources/AutopodDesktopExe/AutopodApp.swift:12,87.

PodStore.configure(api:) only replaces its API reference. It does not clear data
or establish a connection scope. REST status revision fences protect newer status
events within the store; they do not identify a daemon connection. Cached pods,
hydration, diffs, quality scores and series share the store lifetime. See
packages/desktop/Sources/AutopodDesktop/Stores/PodStore.swift:64,160,258.

ActionHandler has one pendingAction string for all requests. Each action writes
and later clears it; production views do not consume it. Pause, Kill and Reply
closures return Void. An old handler retains its original API, while its later
podStore.refreshSession call uses the store's current API. See
packages/desktop/Sources/AutopodDesktop/Stores/ActionHandler.swift:12,188,210 and
packages/desktop/Sources/AutopodUI/Models/PodActions.swift:24.

DaemonConnection has a persisted UUID, independently of its URL and token. The
UUID is available in both entry-point wiring functions. See
packages/desktop/Sources/AutopodClient/DaemonConnection.swift:10,85. Existing
retryDraftScope uses the API URL string, not this UUID.

## Drafts and decision identity

OverviewTab stores replyText in local @State and clears it before starting the
reply Task (packages/desktop/Sources/AutopodUI/Views/Detail/OverviewTab.swift:23,1225).
SessionCardFinal similarly owns reply/resume inputs and clears/dismisses them on
submit (Views/Cards/PodCardFinal.swift:191,1078,1153). DetailPanelView's resume
input is local (Views/Detail/DetailPanelView.swift:444,1195). MainView gives the
detail .id(pod.id), and the Overview tab is conditionally mounted; selection/tab
changes can replace the draft's owner.

The REST EscalationResponse has id; PodMapper reads its question/type/options
without carrying id into the UI Pod. EventStream's escalationCreated handler
also stores only question/options; escalationResolved ignores its ID and clears
escalation state. See AutopodClient/Types/PodResponse.swift:432,
AutopodDesktop/Mapping/PodMapper.swift:155, Stores/EventStream.swift:286 and
Stores/PodStore.swift:382. Compact payloads do not carry a full escalation.
Paused resumption may have no escalation.

## HTTP completion and acceptance

DaemonAPI sends only {message}, with the existing request timeout and no
application-level automatic reply retry (AutopodClient/DaemonAPI.swift:275,1121).
POST /pods/:podId/message awaits manager.sendMessage before returning ok
(packages/daemon/src/api/routes/pods.ts:849).

Normal manager handling records a decision reply and transitions before awaiting
runtime continuation. Continuation can consume an entire stream and subsequently
throw; its error is rethrown to the HTTP route. A failed HTTP response therefore
does not establish that no reply was accepted. Durable receipt deduplication is
keyed by the daemon's current decision; the client request supplies no expected
decision ID or idempotency key. See packages/daemon/src/pods/pod-manager.ts:12980,
13021 and completion-journal.ts:137. No safe cross-decision resend contract is
currently supplied by this client request.

## Existing proof seams and limits

R04a's ephemeral URLSession/URLProtocol fixture invokes actual handlers and stores,
and renders production DetailPanelView in NSHostingView. It avoids application
bootstrap and real preferences/authentication. It can exercise held responses,
event/store races and view composition. It does not establish full-app connection
switching, socket shutdown, keyboard/button activation or user acceptance.

EventStream owns a concrete EventSocket. Its disconnect schedules a Task that
reads eventSocket later, then immediately clears the property. connect calls
that method and installs a new socket. EventSocket owns receive/heartbeat tasks,
but connect/backoff Tasks are not retained. These source facts are the subject
of a separate bounded socket-lifetime research task; no runtime failure is yet
claimed by this report.

## Related artifacts

- plans/2026-10-15-desktop-confirmed-actions.md: completed R04a proof.
- plans/2026-10-15-desktop-state-wireframes.html: Inline proposal selected by user.
- research/2026-10-15-reliability-verification-seams.md: bootstrap isolation facts.

## Open questions

None for the described current-state boundaries. Socket runtime behavior is being
investigated separately. Pending-state and retained-draft implementation choices
belong in a subsequent resolved plan; this report does not authorize a new API.

## Follow-up research — Inline control composition

At121a667a, research_cli traced every Pause/Kill surface; root read full
DetailPanelView, PodCardFinal, PodActivityPanel, PodActions and AppRootView, plus
ActionHandler/app wiring. PodActions already exposes MainActor Sendable getter
closures for existing error state. MainView.wiredActions copies the complete
struct and replaces attachTerminal; detail/cards receive that copy. The enabled
series activity panel is in DetailPanelView and also receives actions. MainView
and SeriesListView DAGs omit actions but disable their panel, so no Pause wiring
defect was established there. Observation through an additional getter would
still need rendered runtime proof; source transport alone does not establish it.

Detail's responsive header shares headerActions across wide/wrapped layouts.
Cards expose Pause, several Kill surfaces and Kill-and-delete. Kill-and-delete
awaits an async Void kill closure and then deletes; current kill catches failures.
A duplicate guard that simply returns early would let this caller continue before
an original request settles. Joining duplicates preserves wait semantics but
would not itself prove successful kill. Daemon deletion has its own authoritative
status/resource ownership checks; the client must not infer success from Void.

Pause/Kill success awaits refreshSession, but that method swallows GET errors.
An HTTP success therefore does not establish that a fresh state was observed.
Cached PodStore rows retained across reconnect are not fresh observations either.
AppRoot's global error listener drives both alert presentation and authentication
recovery, whose successful path directly calls PodStore.configure. Any new request
ownership must account for those lifetimes and both app entry points.

Root inspected manager.pauseSession/killSession. Pause registers an in-memory
pause intent, suspends the runtime, then awaits quiescence. A409 can mean the
runtime was already suspended but did not settle in time; it does not universally
mean no side effects. Concurrent Pause is rejected while its intent remains.
Kill publishes killing before cleanup, which can last30seconds, matching the
client's default timeout. Network/decode/HTTP failure cannot generally establish
non-acceptance. Observed REST/event status can establish current state, not causal
attribution to a particular request. No automatic replay contract is present.

R04b socket ownership is now integrated. R04c REST response epochs are independently
reviewed in PR427; they preserve caches and do not fence an old handler's new
follow-up call after configure. Pending request and draft ownership remain a
separate plan. No new UI, request coordinator or retry policy is implemented by
this research.

## R04d validation prerequisite — Swift 6.3.3 fixture capture

At baseline 80fc81589fa8e6da493fc96a7ca7909dde4e4e20, a fresh local Swift
6.3.3 build rejects EventStreamResyncTests.swift:72: the Task closure implicitly
captures URLProtocol self while transferring the closure. The failure persisted
after `swift package --package-path packages/desktop clean`; no production edit
had been applied. Logs are under ignored `.autopod-data/reliability/r04d/`
(`baseline-rerun.log`, `baseline-clean.log`). Earlier disk exhaustion is separate.
The coordinator's desktop reviewer checked that hosted R04c used Swift 6.1.2;
local passing incremental runs had reused this test's object.

DaemonAPITests.swift:463–464 already snapshots `self.request` and uses explicit
`@Sendable [self, request, handler]` captures for the equivalent URLProtocol task.
Root authorized exactly that test-only alignment, with no assertion, handler or
production behavior change, followed by resync runtime and baseline action tests.
