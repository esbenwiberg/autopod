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
