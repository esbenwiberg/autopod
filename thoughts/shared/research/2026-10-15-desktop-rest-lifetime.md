---
date: 2026-10-15T21:15:08.774961+02:00
researcher: Codex
git_commit: 228555a56264154b8e33da6c3a9577ab23325c06
branch: codex/reliability
repository: autopod
topic: "PodStore request ownership across API replacement"
status: complete
last_updated: 2026-10-15
last_updated_by: Codex
---

# PodStore REST lifetime

## Findings

Root read the full PodStore, ActionHandler, both application entry points,
PodStoreFleetTests and ConfirmedActionTests. research_desktop independently mapped
all six async store entry points. configure(api:) only changes the API reference
(PodStore.swift:64), preserving cache, admission, revisions, errors and loading.
Methods capture API at entry but never verify ownership after awaits.

loadSessions (:159–229) can apply an old fleet, delete selection, publish an old
error or clear current loading. Its selected hydration await is followed by
loading cleanup and loadQualityScores, which captures whatever API is current
then. loadQualityScores (:233), refreshSession (:247), loadSeries (:288) and
loadDiff (:308) can apply old payloads after replacement. Empty old diff removes
a current cache entry; loadSeries also returns its old response to the caller.
hydrateSessionIfNeeded (:274) uses shared ID sets: old admission can suppress new
hydration; its unconditional defer can remove a newer admission if sets are reset.

Existing status revisions protect newer socket events, not configuration identity.
Using only API object equality cannot distinguish A→B→the same A object. A new
configuration has no explicit stable daemon identity. Fresh B results can still
merge with already retained A rows by ID/timestamp; response fencing and complete
daemon-data separation are distinct contracts.

Application disconnect removes the stream but does not invalidate PodStore.
Reconnection configures it again. Auth recovery also calls configure directly
(AppRootView.swift:458). This research therefore establishes configure boundaries,
not immediate disconnect or all old ActionHandler follow-up admission.

## Verification seams

PodStoreFleetTests covers pagination, fleet retention/removal and hydration caches;
no held-response A/B replacement test exists. Its global protocol handler and
unbounded yielding gate are unsuitable for the new failure-path fixture.
ConfirmedActionTests has per-host held requests, deadlines, cancellation and
fail-closed ephemeral URLSession routing. A small test-only extraction can share
that transport, leaving existing action assertions unchanged. Production already
supports injected DaemonAPI session. No account/app/preferences/bootstrap needed.

## Open questions

None for this current-source map. No regression has yet executed. Scope choices
between response ownership, cache identity and immediate disconnect belong in the
plan. UI presentation and reply drafts are separate tasks.
