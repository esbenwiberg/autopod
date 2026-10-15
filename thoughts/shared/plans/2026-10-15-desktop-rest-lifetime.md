# R04c: fence PodStore REST work after reconfiguration

## Scope and authorization

User authorized autonomous RPI phases and branch-contained reliability fixes.
Research: ../research/2026-10-15-desktop-rest-lifetime.md. Implement only ownership
of REST work admitted before a newer configure(api:). No UI/layout/API-wire change,
no cache identity redesign, no action replay, no immediate disconnect guarantee.
Root owns this resolved plan; worker implements all phases, then independent
review before PR. No user manual test is required for this isolated store contract.

## Desired result

Every configure call establishes a monotonically advancing local epoch, including
A→B→the same API A. Work admitted in older epochs cannot change store state, clear
current loading/error or hydration admission, start follow-up store requests, or
return an old series payload as current. Current work and same-epoch event/REST
merge rules retain their behavior. Configuration preserves confirmed cached data;
this is explicitly not complete daemon-data separation.

## Phase1: regressions at real URLSession/store boundary

Add PodStoreLifetimeTests and a bounded per-test A/B transport fixture. Reuse the
held-request mechanism from ConfirmedActionTests via a small test-only extraction
if useful; do not expand its semantics or replace existing assertions. Private
ephemeral sessions, unique synthetic hosts, exact request barriers, bounded waits,
owned request/task cleanup on success/failure; unexpected requests fail closed.
No busy-yield waits, real auth/defaults or production app bootstrap.

Baseline cases before product edits:
- Hold A list; configure B and establish B fleet/selection; release A success and
  separately failure. B fleet/selection/error remain unchanged. Hold B list while
  finishing A and assert A cannot clear B isLoading or trigger B score requests.
- Hold A detail refresh; configure B and seed/update B same-ID pod; release A and
  verify it cannot overwrite/append or mark the ID hydrated for B.
- Hold A scores, series, nonempty diff and empty diff. After B is configured and
  current values established, release A and verify no cache/upsert/removal. Old
  series call returns nil. Exercise current B calls to prove normal behavior.
- Hold A hydration; configure B; start/hold B same-ID hydration; finish A; call B
  hydration again and assert only one B request is active. Finish B and assert
  caching suppresses a further redundant request. Reconfigure even to the same
  API object and prove a fresh hydration is admitted.
- Replace during A loadSessions' selected hydration await. A continuation cannot
  reset current loading or initiate quality-score work against B afterwards.
- A→B→A object re-use still invalidates the first A work.
Record actual baseline failures; if an assumption fails, report before revising.

## Phase2: production ownership guards

Own only packages/desktop/Sources/AutopodDesktop/Stores/PodStore.swift.
Add a private configuration epoch advanced by every configure call. Reset only
request/admission metadata: hydrated/hydrating sets and transient loading/error
state. Keep visible pods/selection/score/diff/series caches and merge/revision rules
unchanged; broader connection-scoped baseline policy is deliberately separate.

Each async entry captures epoch at admission. Check it immediately after awaits
before any state mutation or returned series response. Check list failure cleanup,
loading cleanup and before score follow-up; recheck after selected hydration's
await. Superseded list completion returns without launching work on the current
API. Hydration defer only removes its admitted epoch's entry; old completion must
not remove B's admission or mark B hydrated. Current success/failure paths and
existing best-effort behavior remain unchanged. No request cancellation API is
required: transport may finish, but stale results cannot affect current state.
Do not refactor unrelated merge logic or add dependencies.

## Phase3: verification and integration

Run native focused new tests, PodStoreFleetTests, confirmed-action/decision/mapper
and stream resync tests; full Swift tests and desktop executable build; secret
scan/diffcheck. Existing opt-in live test stays explicitly skipped. Capture clean
final revision and exact commands/logs under ignored reliability/r04c evidence.
Independent review reads every guard/catch/defer and reruns held A/B cases before
PR into codex/reliability. Await hosted native/general checks, merge, then rerun
new store and affected confirmed-action tests on integration.

## Acceptance

- [ ] Baseline superseded responses reproduce failures.
- [ ] All six async entry points reject superseded results/follow-up work.
- [ ] Hydration admission and loading/error cleanup retain current ownership.
- [ ] Current behavior and existing event merge tests pass.
- [ ] Independent pre-PR, hosted and integrated proof complete.

## Limits and rollback

No rendered UI claim or screenshot required. This does not clear cached A data
when switching to B, fence a new call made by an old ActionHandler after configure,
invalidate immediately on disconnect, or isolate other stores. Those boundaries
are explicitly outside this change and must not be described as solved.
Reverting requires no migration. No persistent state or wire contract changes.
