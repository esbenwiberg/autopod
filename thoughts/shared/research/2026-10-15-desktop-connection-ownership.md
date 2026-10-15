# Desktop cached data and action ownership

Research at be22402d57eb2001e6e5e0dd02bddde4861b311d (2026-10-15).
research_desktop mapped all handler paths; root rechecked store configuration,
entrypoint wiring, action source/async boundaries and journal utility. No new
runtime tests or product changes. Related research: reply-draft-identity.md and
reply-acceptance-boundary.md. R04c protects already-started store REST responses;
R05b protects newer decisions within the current model. Neither binds handler
authority or cached models to the replacement connection.

PodStore.configure advances configurationEpoch, replaces API, resets hydration
admission/loading/error but retains pods, selection, diffs, quality scores and
series. Therefore already-visible A data can remain after configuring B. Equal
or older compact B timestamps may retain a same-ID A model. No saved UUID or
per-pod connection provenance is stored. Same connection reconnect should be
distinguished from a different UUID/endpoint; saved UUID is not daemon incarnation.

ActionHandler keeps immutable API plus shared store, with no configuration token.
Weak callbacks check only handler existence; active methods/owned control tasks
retain it across awaits. Current exact sites in Stores/ActionHandler.swift:

- Direct A-response upserts: intentional rerun124–125, fix318–320, create479–481,
  fork561–562, waiver658–660, series725–727, worker803–804.
- Removals: delete580–581 and series591–592 act on current shared IDs.
- Old response followed by current store refresh: retry138–144, reply206–209,
  controls254–256, retryPR380–381, resume391–395, recovery406–410, force425–426,
  kick437–441, skip619–620, update740–742. Fleet discovery516–528 is similar.
- Generic mutations and Goal/retry callbacks also have no connection admission.
  Read callbacks can return old results directly to their awaiting views.

Store epochs do not guard direct upsert/removal. A refresh begun after B configure
captures B's API/epoch even when triggered by old A work. Kill→Delete267–289 can
continue on A after its awaited Kill/refresh. Fork535–566 and worker762–807 read
shared source state, then perform multiple A requests, journal and upsert without
connection checks. Series719–732 journals before its request.

Both application entrypoints53–59 only disconnect/nil EventStream when connected
becomes false. Handler and PodStore API remain. Their87–96 configure the same store
then replace handler on connect. AppRootView passes actions independently of
isConnected. ConnectionManager saved switching uses connecting state then commits
new metadata/API after health/stats; failure restores previous state.

DaemonAPI1121–1144 has another suspension before URLSession: it awaits token
provider. Handler admission before an API call cannot cancel an operation already
admitted to that actor, including one waiting on credentials. No stronger network
cancellation or server rollback follows from a client configuration fence.

Private PodStoreLifetime/ConfirmedAction fixtures can hold actual A responses
while B configures, observe colliding IDs, detect late upsert/removal/follow-up GET,
and exercise actual control chains. No existing test proves handler replacement
isolation. LaunchRequestJournal.save/saveSeries accept optional directory, but
handler calls omit it and write under user home. Full successful fork/series/worker
proof requires a narrow handler storage seam; pre-journal cutoffs are already
exercisable. Journal formats, request keys and file permission behavior are existing
authority; they are distinct from unsent reply drafts.

Independent plan review found a third PodStore configuration site:
AppRootView.recoverAuthenticationAndReload:462 configures it directly after auth
recovery, without replacing ActionHandler. Local refreshDevToken:655 can replace
API while remaining connected; the isConnected observer need not fire. Automatic
pollHealth can also call refreshDevToken with that same outcome. Root read the
complete ConnectionManager and both entrypoints to verify these paths. Passing
UUID alone would preserve cache but still invalidate the current handler.

EventStream.disconnect advances its generation synchronously, fencing queued
socket callbacks. Already spawned store-refresh Tasks can still begin a current
store GET; historical/resync work can settle into the old stream's private buffers.
A replacement must explicitly disconnect the old stream before changing store
ownership. This is distinct from claiming cancellation of every admitted Task.

Goal load in ActionHandler catches DaemonError.notFound and returns nil. A proposed
ownership helper must validate thrown results as well as successful ones; otherwise
a late old404 would still be interpreted as a benign current absence.

Follow-up review confirmed automatic token replacement at pollHealth:482 and
refreshDevToken:662. API object identity changes while isConnected can remain true;
baseURL is immutable on that object. The new API is published before the health
await returns. Current Boolean-only app observers miss this replacement. There is
no existing account-free ConnectionManager initializer; private recovery sequencing
and a connection-specific wiring gate can be tested without authenticating.
