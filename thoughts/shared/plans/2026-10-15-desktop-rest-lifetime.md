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
  caching suppresses a further redundant request. Also fail current B hydration,
  await it, then hydrate again and assert a fresh request is admitted (failed
  hydration must release its own admission without marking it hydrated).
  Reconfigure even to the same
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

- [x] Baseline superseded responses reproduce failures.
- [x] All six async entry points reject superseded results/follow-up work.
- [x] Hydration admission and loading/error cleanup retain current ownership.
- [x] Current behavior and existing event merge tests pass.
- [x] Independent pre-PR, hosted and integrated proof complete.

## Limits and rollback

No rendered UI claim or screenshot required. This does not clear cached A data
when switching to B, fence a new call made by an old ActionHandler after configure,
invalidate immediately on disconnect, or isolate other stores. Those boundaries
are explicitly outside this change and must not be described as solved.
Reverting requires no migration. No persistent state or wire contract changes.

## Independent plan review

research_cli found no design blocker and added a current-epoch hydration failure/
retry case to verify defer ownership on both success and failure. Root accepted
that addition. Internal pagination already inside DaemonAPI may continue for A;
the store rejects its final result. This task does not cancel network requests.

## Implementation evidence

Phase 1: production remains unchanged. `swift test --package-path packages/desktop
--no-parallel --filter PodStoreLifetimeTests` exited 1: seven test functions,
six failed and fixture failure-cleanup passed, 42 issues in 100.734 seconds.
Evidence: `.autopod-data/reliability/r04c/baseline.log`. Assertions demonstrate old
fleet/selection/error/loading writes, unwanted B score follow-ups, old detail
hydration, scores/series/diff writes, suppressed B hydration and A-object reuse.
Some additional baseline issues are expected fail-safe deadlines releasing the
unfixed implementation's unexpected requests. These are not counted as separate
product defects. Held REST transport was extracted without behavioral changes;
only its registry became test-module internal for sharing.

Phase 2: `PodStore` now advances an epoch on every configure, resets only
hydration admission and transient loading/error state, and rejects superseded
responses before writes. List catch/cleanup/follow-up and hydration defer retain
epoch ownership. Visible caches and existing merge/revision rules are unchanged.
Production diff: 24 added lines and one removed line.

Phase 3 worker validation (Swift 6.3.3, macOS arm64):

- `swift test --package-path packages/desktop --no-parallel --filter PodStoreLifetimeTests`
  — exit 0; seven functions / fourteen scenarios, no deadline expirations or
  active fixture requests at cleanup (`fixed-regression.log`).
- `swift test --package-path packages/desktop --no-parallel --filter 'PodStoreLifetimeTests|PodStoreFleetTests|confirmedAction|confirmedKill|ReplyDecisionRetentionTests|PodMapperTests|EventStreamResyncTests'`
  — exit 0; 50 tests in three suites (`affected-tests.log`).
- `swift test --package-path packages/desktop --no-parallel`
  — exit 0; 13 XCTest tests and 418 Swift Testing tests in 15 suites
  (`swift-tests.log`). Existing opt-in LiveVillageConnectionTests and its test
  explicitly skipped. No live credentials or services were used.
- `swift build --package-path packages/desktop --product AutopodDesktopExe`
  — exit 0 (`swift-build.log`).
- `node scripts/secret-scan.mjs` and `git diff --check bafc75bf1376ffcb2d5670c626731f2334d0f3c7`
  — exit 0 (`secret-scan.log`, `diff-check.log`).

All logs live under ignored `.autopod-data/reliability/r04c/`. Baseline commit
`929e0a05` preserves the failures against unchanged production. An initial
incremental rebuild diagnosed a sending closure in unchanged EventStreamResyncTests;
a clean rebuild removed that diagnostic. That clean build was then rejected
because an EOF whitespace correction was made during compilation. Sources were
frozen and the regression, affected, full-suite and build commands above passed.
No unrelated code was changed to address those build attempts.

Worker verdict: PROVEN for the configured response-epoch contract only. Existing
fixture closure invocation and real URLSession decoding prove store behavior;
there is no full-app, visual, live-daemon, immediate-disconnect, transport
cancellation, cached-daemon separation or old-action admission claim. Final
revision and source/log hashes are recorded in ignored `proof.json`. Independent
review, hosted checks and integrated rerun remain root-owned and unchecked.

## Coordinator integration proof

Independent pre-PR review atde47339b inspected all response/cleanup guards and
reproduced17 focused test functions. PR427 passed general and native hosted checks
(runs38794284199/38794284345), then merged at80fc8158.

The first integrated rebuild failed in unchanged EventStreamResyncTests; the
clean retry separately ran out of disk. R04d reproduced the fixture diagnostic
after a clean Swift6.3.3 build. Hosted builds use Swift6.1.2. Earlier local passes
were valid runtime evidence but reused the resync object; cleaning alone was not
a reproducible fix. A separately reviewed two-line explicit-capture alignment
with the adjacent fixture passed local resync/baseline proof and hosted native
Swift/Xcode checks in PR430 (runs38797040079/38797039954), merging at43a5fad2.

At43a5fad2 the integrated command below recompiled the resync fixture and passed
18 test functions in3suites, including parameterized confirmed-action scenarios:
`swift test --package-path packages/desktop --no-parallel --filter
'EventStreamResyncTests|PodStoreLifetimeTests|PodStoreFleetTests|confirmedAction|confirmedKill'`.
Evidence: `.autopod-data/reliability/r04c-integrated-final.log`; earlier failed logs
are retained. The store contract is proven with the original scope limitations.
