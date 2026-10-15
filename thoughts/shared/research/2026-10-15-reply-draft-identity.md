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
PodStore.swift:147 replaces hydrated question from compact data while preserving
hydrated type/options; its configured request epoch does not identify decisions.

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
