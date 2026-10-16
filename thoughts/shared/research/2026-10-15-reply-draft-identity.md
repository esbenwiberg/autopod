---
date: 2026-10-15T21:56:21.660467+02:00
researcher: Codex
git_commit: 8d2ad27b1ef287164f0b7862c1ff9401123fd2ed
branch: codex/reliability
repository: autopod
topic: Existing reply draft ownership and decision identity
status: complete
last_updated: 2026-10-15
last_updated_by: Codex
---

# Reply draft ownership and decision identity

Research only for the campaign's existing reply/resume reliability work. No new
API, storage or presentation is implemented or approved by this report. Agent
research_desktop traced sources atf818a8b3; root checked the load-bearing mapping,
event, connection and journal paths. The later8d2ad27b changes only documentation.

OverviewTab.swift:23,1225 owns reply text in local State and clears before invoking
an async Void action. PodCardFinal owns separate reply/resume text; submit clears
and dismisses before completion. DetailPanelView also has local resume text.
MainView.swift:788 gives detail pod identity; conditional Overview mounting can
remove its local owner. Same-pod decision replacement does not reset that owner.
Both application entrypoints retain PodStore but replace ActionHandler when wiring
a connection. Neither provides a shared reply draft owner.

TaskRetryCard.swift:15 and DispatchPreflightCard.swift:14 persist submitted retry
or rerun requests in UserDefaults.standard, keyed by API URL plus pod/stage. They
save immediately before POST, retain on failure and remove after success. Unsent
text remains local State. Their view task identities omit connection scope.
These are request journals with their own request keys, not generic reply drafts.
ActionHandler.swift:85 supplies retryDraftScope from api.baseURL.absoluteString.
DaemonConnection.swift:10 supplies a persisted UUID available at both app wiring
sites. It identifies a saved connection record, not a verified daemon incarnation.

PodResponse.swift:6 exposes optional finalization.pendingDecisionId for compact
and detail payloads; detail additionally exposes pendingEscalation.id at432.
PodMapper.swift:67,154 maps question/type/options but does not carry either ID
into UI Pod. EventTypes.swift:198 preserves created/resolved escalation IDs;
EventStream.swift:336 drops the created ID/type and ignores resolved ID at350.
PodStore.swift:181 removes stale hydrated IDs before selecting its merge helper.
Consequently newer compact rows take mergeRestPod and lose unavailable detail
fields; equal/older hydrated rows remain unchanged. The apparent field-preserving
newer mergeCompactPod path is unreachable through loadSessions. The configured
request epoch does not identify decisions.

The compact finalization ID is not a universal identity for a live waiting
escalation. completion-journal.ts:96 settle writes pendingDecisionId from
pod.pendingEscalation.id when the agent settles; an earlier live question may lack
that finalization ID. recordReply uses the actual pending escalation ID and clears
matching journal entries. This limits what compact-only client data establishes.

PodActions.reply returns Void. ActionHandler catches POST errors into shared
lastError, while a successful POST awaits refreshSession, whose GET errors are
swallowed. An absent weak handler also returns normally. Completion therefore
does not establish reply acceptance or a freshly observed next decision.
DaemonAPI sends only message; the route awaits manager.sendMessage. The manager
can record a durable reply before runtime continuation later fails. There is no
client expected-decision or request key in this existing reply request. A failed
HTTP response does not establish that nothing was accepted.

## Existing proof boundaries

ReplyDecisionRetentionTests exercises real handler/URLSession POST failure,
failed refresh and observed awaiting-input/validating/running responses; it asserts
pod state, not text retention. HeldRESTTransport supplies private peers, held
responses and teardown. PodStoreLifetimeFixture supplies independent A/B APIs.
ConfirmedActionRenderingTests mounts production DetailPanel/Overview; it currently
does not enter reply text, replace decision-bound drafts or activate controls.
These seams avoid defaults/auth/accounts but do not prove full-app connection
switching. No existing fixture proves shared draft survival because that owner
does not currently exist.

## Open questions

None for these current-source facts. Draft ownership, persistence, retirement and
ambiguous-response presentation belong in a subsequent bounded plan. Research
does not imply that a saved draft may safely be resent to a newer decision.

## Follow-up trace: decision identity and ordering

Root fully read native Pod, PodMapper, PodResponse, PodStore, EventStream,
EventTypes and relevant existing decision/fleet/lifetime tests at14475fce. Agent
research_desktop independently traced compact serialization and ordering.

Detail pendingEscalation.id and escalation-created/resolved events identify the
decision, but UI Pod currently discards that ID. Compact SQL selects bounded
escalation JSON internally; compactPod in api/routes/pods.ts serializes only its
500-character summary. Shared CompactPod and Swift CompactPodResponse have no
live escalation ID. This is not an existing wire field ignored by Swift.
Finalization.pendingDecisionId covers settlement only and cannot identify every
live question. Equal summaries can belong to distinct decisions.

refreshSession accepts equal and older detail payloads through
preferIncomingOnEqual=true. Existing merge protection retains lifecycle status
when an event arrives during a request, but incoming question/options/type can
still replace a newer decision. Event-driven status revisions do not advance
updatedAt; the repository timestamp is neither a unique decision revision nor
a cross-stream ordering token. Resolved events currently ignore escalationId
and clear any current question, setting Running regardless of the current ID.
Socket generation fencing rejects old connection callbacks, not old decisions
within one current connection. EventSocket replay-watermark tracking also does
not suppress every equal/older event before delivery.

These are source-level findings, not newly executed race reproductions. Stable
draft association requires preserving identity and defining unknown identity;
question text and settlement metadata cannot substitute for an active ID.
Server-side expected-decision binding and complete cross-stream ordering are
separate from merely retaining client text. No mutation/API/storage changes are
authorized by this research artifact alone.

## Follow-up Research: connection provenance and retained owner

At campaignddd3c492, research_desktop traced both application entrypoints,
ConnectionManager, AppRootView, PodStore, ActionHandler and current reply views.
Root reread the entrypoint, connection switching/disconnect, model and affected
store/action/view paths. R05b subsequently merged atbe22402d: its identity fields
and fences supersede the earlier statements that IDs are discarded, but do not
provide connection provenance or draft ownership. No new tests run for this trace.

PodStore is app-level State in both AutopodDesktopExe/AutopodApp.swift and
Autopod/AutopodXcodeApp.swift. Every handler replacement receives that same store.
wireUpConnection has saved conn.id but currently passes it to neither store nor
handler. Disconnect tears down EventStream only; reconnect configures the same
store and replaces ActionHandler. Store configure retains visible pods, selection
and cached data while advancing its REST response epoch. Therefore already-visible
A data may remain under B, even if no old request is allowed to finish. Same-ID
compact B discovery can preserve A based on timestamp. A current saved UUID cannot
alone establish the source of an existing cached question.

Saved connection UUID survives reconnect/token replacement. ConnectionManager's
saved-record switch changes metadata/API after successful health/stats and restores
previous state on failure. URL is mutable in the model, though no ordinary edit
flow was located; UUID is not a daemon-incarnation identity. Clearing on every API
configuration would also clear same-record reconnect state.

Overview/card reply and paused-resume texts are separate local State. Detail
selection/remount loses text; a different question on the same pod does not reset
that owner. Both typed and option replies clear before async Void submission.
The weak-handler wrapper can return normally without a handler; POST errors are
caught and GET errors swallowed. Thus Void completion/lastError absence cannot
prove acceptance. Paused resume/guidance have no exact escalation identity and
cannot automatically share a decision-keyed namespace. Existing retry journals
remain separate, request-keyed operations rather than typed-text ownership.

Existing private PodStoreLifetimeFixture supplies A/B APIs, held requests and
real decoding. It can expose cached A immediately after B configuration, including
colliding IDs/timestamps. R05b native fixtures can render typed decisions across
state changes but do not yet prove keyboard text retention or connection switching.
Connection ownership and asynchronous handler writes need a bounded follow-up
map before a shared draft is attached to the visible decision.

## Follow-up Research: concrete reply surfaces after R05b/R07a

At2a8c0dda, root reread complete OverviewTab, SessionCardFinal, PodActions,
ActionHandler and PodStore, plus ReplyDecisionRetentionTests and the complete
DecisionIdentity fixture/rendering tests. Desktop reviewer independently mapped
the same submission paths. R04e is implementing fromf8693f23 and remains a plan
prerequisite, not completed connection evidence.

OverviewTab:456–574 renders typed, option and action-approval replies; all converge
on sendReply:1225. It clears local text before an async Void callback. The view can
unmount when its detail tab changes. SessionCardFinal:755–793 has direct approval
buttons and a Reply button that presents its sheet; the sheet:1115–1200 has local
text, direct option submission and immediate clear/dismiss for typed submission.
Its explicit Cancel clears text. Card and Overview own independent State values.
Card paused Resume:199–208 and Detail paused Resume:451 call the older reply action
without escalation identity. Nudge, retry journals and validation approval use
separate paths; their retention semantics are not decision-draft semantics.

PodActions.reply has a default no-op and async Void return. Its existing weak
handler wrapper also returns normally if the handler disappeared. Neither boundary
establishes acknowledgement. Handler's ordinary POST/refresh semantics and daemon
post-acceptance failures are documented in reply-acceptance-boundary research.
An exact known escalation ID is present after detail decoding or created events;
compact discovery alone supplies only a summary. Compact nil is not a stable
decision identity, and equal question text does not establish one.

The existing native identity fixture mounts actual DetailPanel/Overview in one
NSHostingView, uses private defaults, real EventStream/PodStore and held URLSession
responses, and inspects 600/900px captures. It does not type text. R07a's production
palette tests establish real NSTextField field-editor input and NSApplication
keyboard-event delivery in the same helper environment. Literal mouse activation
of SwiftUI static rows was not established there. No existing fixture proves the
card reply sheet opens/submits, shared text survives remount, or ambiguous delivery
retains its captured text. These remain test targets, not passing evidence.

CLI follow-up/root source check: the card .sheet modifier:790 is attached only
to its non-action-approval Reply branch. A detail refresh can reveal approval type
and remove that presenting branch. PodStore refreshSession catches errors and
hydrateSessionIfNeeded can return immediately for an admitted hydration, so Void
completion is not a successful detail-loading signal. Its existing merge carries
decision revisions across the request; bypassing it with a raw DTO upsert would
lose R05b ordering. MainView's action forwarding copies the whole PodActions value
and replaces only attachTerminal, preserving additional action fields.
