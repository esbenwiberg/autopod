# R04e: bind cached pods and actions to their connection

## Scope and authorization

Repair the current desktop connection boundary before attaching retained drafts.
User authorized autonomous RPI, workers, independent pre-PR review and campaign
integration. Root owns this plan from desktop-connection-ownership research. An
inline wireframe was shown: same-connection reconnect keeps readable last-observed
state, while a different connection clears prior pods and uses existing loading/
empty presentation until its own data arrives. No new layout or navigation.
All technical phases below are authorized together after independent plan review.

## Desired behavior

A new saved connection or endpoint cannot inherit cached pod/selection/detail data
from the old one. Reconnecting the same saved connection and endpoint preserves
readable cached data, but every configure/disconnect creates a new action/request
ownership generation. A handler from an older generation cannot admit new actions,
publish results into the current store, start follow-up requests or continue
Kill→Delete. Already-admitted requests may still settle externally; their results
are fenced locally. No automatic replay or inferred remote cancellation.

Scope is PodStore plus ActionHandler and their app wiring, not every other desktop
store, terminal, direct UI API or connection-manager authentication race. Shared
reply draft storage/submission is subsequent work. This task provides the source
boundary needed for those drafts, not a full application isolation claim.

## Phase 1: reproduce through existing paths

Add focused connection-ownership tests using existing held private URLSession
transport and real DaemonAPI, PodStore and ActionHandler. Preserve failing baseline
source/log and exact revision before production changes. Cases: cached A pod/
selection/diff/score/series remain when configuring B; A delayed fix-manually
response overwrites same-ID B; delayed A DELETE removes B; A POST acknowledgement
starts a B refresh; an old handler invoked after replacement still sends A work.
Use only synthetic data/controlled endpoints. Baseline may target current API-only
switch; saved-UUID assertions belong after introducing that argument.

No account startup, Keychain, real network, system defaults or user-home journals.
Use existing private files and owned request/task teardown, bounded admission
barriers and actual request-count assertions. Test failure must not leave tasks,
sessions or timers live.

## Phase 2: store source identity and generation

Own Sources/AutopodDesktop/Stores/PodStore.swift. Extend public configure with
optional saved connection UUID (default nil for source compatibility). Define the
source key from that UUID and api.baseURL; URL is included so a same-record endpoint
change does not inherit old data. With no UUID, endpoint remains the fallback key.
Compare keys separately from per-configuration ownership. Do not derive identity
from label, token, question text or pod ID. No daemon-incarnation guarantee.

On a different source key, clear pods, selection, sessionDiffs, qualityScores,
seriesCache and their per-pod hydration/status/decision/insertion bookkeeping.
Keep monotonic sequence counters non-reused. On the same source, retain cached
state. Every configure still advances existing REST epoch and resets transient
loading/error/admission as before. Initial configuration has no trusted prior
source; do not attach arbitrary preconfiguration models to a new source.

Expose a narrow internal immutable ownership token for an API configured in this
store, and a synchronous current-token check. Handler construction captures it
only if its API belongs to that configuration. Epoch/token invalidation must work
even on same API object or A→B→A. Use no public mutable bypass.

Add public disconnect/invalidate method for app wiring: advance ownership/REST
epoch, remove usable API and hydration admission, reset loading/error, retain
last-observed cached source/selection. A later same-source configure can preserve
it. Old in-flight REST cannot publish or begin nested follow-ups while disconnected.

Update both Sources/AutopodDesktopExe/AutopodApp.swift and
Autopod/AutopodXcodeApp.swift: pass conn.id on configure; explicitly disconnect the
old EventStream before configuring replacement owners. Invalidate PodStore and
clear the last-wired identity on disconnect. Keep both entrypoints aligned.

Observe one optional active wiring identity instead of only isConnected: present
when connected with API and saved connection; composed of saved UUID plus API
object identity (its immutable baseURL accounts for endpoint changes). Ordinary
observer/onAppear wiring is idempotent for the same identity. Use a small shared
connection-specific identity/gate value, not a generic service coordinator. The
same API after disconnect still creates a new generation. This covers automatic
pollHealth/refreshDevToken replacement while isConnected remains true.

AppRootView.recoverAuthenticationAndReload is a third configuration path. Add a
required synchronous onConnectionRecovered callback; both entrypoints pass the
same wiring method with forceNewGeneration. After successful recovery call it
before reloads. Remove AppRoot's duplicate shared-store configure calls; retain
its locally owned launchConfiguration configuration/reload. An internal MainActor
recovery sequencing function taking async recover and synchronous onRecovered
closures permits private tests without constructing ConnectionManager (whose init
restores user credentials). A failed recovery invokes no callback. Explicit
recovery intentionally forces ownership even when API identity is unchanged;
later ordinary observation skips that identity. If an observer ran first, recovery
may create one additional intentional generation; no exactly-once global auth claim.

No ConnectionManager startup/auth refactor or app bootstrap. Its dev-token path
publishes API before health settles; the observer follows current connected/API
state, not a new health-validation contract. Explicit old-stream disconnect fences
queued socket callbacks, not already spawned store GETs or old historical Tasks.

## Phase 3: handler admission and result ownership

Own Sources/AutopodDesktop/Stores/ActionHandler.swift. Capture the store token
at initialization. Centralize before/after-await checks in a small typed helper
used for this handler's API operations, including read/Goal/retry closures in
actions. Verify current authority before admitting a call and after completion
before exposing its result. Validate ownership on thrown completions too, before
caller error normalization (especially Goal 404-to-nil); obsolete errors must not
become benign current results. Also guard local source reads and journal writes
that precede requests. Do not retain caller-captured old models across suspension
without the same generation check.

Apply consistently across direct upserts/removals, shared-store refresh/load
follow-ups, returned IDs/results, native app opening, multi-step fork/worker/
series, ordinary controls, and Goal/retry callbacks. Preserve method return types
and current error presentation channels. Use existing error UI for obsolete action
admission with clear wording such as 'Connection changed. Refresh before continuing.'
No new alert layout, automatic retries or status inference. Weak missing-handler
behavior is not redefined as acknowledged success.

Pause/Kill/combined deletion still coalesce within the current handler lifetime.
A superseded control must return non-success for workflow chaining; checks must
prevent subsequent DELETE even if the old Kill was acknowledged before a connection
change. Keep owned-task cleanup/idempotence; do not cancel shared work merely
because one caller stops awaiting it. Handler-local pending/error state must settle
without publishing into replacement store state.

For fully private validation, add a narrow default-preserving optional journal
root to handler construction and pass its separate launches/series child directories
to existing LaunchRequestJournal functions. Default nil must preserve current
production paths, format, keys and permissions. Do not alter journal authority,
retention or retry semantics. Check ownership before each journal write; no new
API/service-locator abstraction is needed.

## Phase 4: regression and observable proof

Required affected tests after fix:
- Different UUID with same endpoint, different endpoint with same UUID, and A→B→A
  clear old source data; same UUID/endpoint reconnect retains it. All caches and
  selected decision fields are accounted for. Unknown UUID uses endpoint fallback.
- Old REST success/error and handler upsert/delete cannot mutate replacement pods
  with identical IDs. Old acknowledgements cannot start B detail/fleet refresh.
- Same API object reconfigured invalidates old handler; disconnected handler cannot
  send fresh work. A new handler works normally after configure.
- Connected API replacement without a Boolean transition rewires real store/handler
  through the shared gate; cache survives same source and old handler fails while
  new handler succeeds. Repeated observer/appearance delivery does not reconfigure.
  Same API after disconnect and changed UUID both reconfigure. Explicit same-API
  recovery forces ownership; following ordinary observation does not invalidate
  the new handler. Failed recovery invokes no callback. Exercise the actual narrow
  recovery sequencing function with held private closures and no ConnectionManager.
- Retain an old EventStream instance, disconnect it before replacement, then deliver
  old callbacks: no old mutation/admission; replacement callbacks work. Extend the
  existing controlled-socket fixture; do not claim all admitted Tasks are cancelled.
- Held Kill or refresh followed by invalidation cannot proceed to DELETE. Same-kind
  coalescing and independent pods still pass in a current handler.
- Goal/retry direct closures and ordinary mutation admission reject obsolete calls
  without HTTP. Read closures reject late old results and errors, including a held
  late Goal404; a current-generation Goal404 still returns nil.
- Fork/worker multi-step changes cannot proceed to next API/journal after ownership
  changes. Private successful journal/launch paths still work and current results
  publish. Series journal and returned pod-array publication covered. Use a temporary
  journal root; never touch user home to qualify this.
- Isolated token-provider hold documents admitted-request limit: after admission,
  external request may still occur; response cannot publish/start another operation.
  Do not claim a per-request server abort or transport cancellation.

Mount actual production MainView/Detail components with the store and controlled
handler actions in owned native windows (serialized). Observe selected A question,
same-source reconnect retention, and different-source removal before B returns;
then show B's same-ID question without A content. Use existing synthetic native
fixtures/private defaults, capture material states and inspect each. This verifies
component/store wiring, not full account switching or compositor/user signoff.
Do not introduce production UI test hooks where existing bindings suffice.

Run new focused tests plus PodStoreLifetime/DecisionIdentity/ConfirmedAction/
InlineControl/ReplyDecisionRetention/FactWaiver/UnverifiedTermination tests; full
Swift with --no-parallel, executable build, Node22 secret scan and diffcheck.
Record actual functions/cases/skips/exits and exact frozen SHA. Independent review
checks every handler API call/admission path, both entrypoints and recovery wiring, reruns material
races and inspects captures before PR. Hosted general/native and integrated
affected checks must pass before closure.

## Acceptance and limits

- [x] Baseline ownership failures reproduced with private transport.
- [x] Source-key cache behavior and per-configuration invalidation proven.
- [x] Handler admission, result publication and chained follow-ups fenced.
- [x] Private journal and same-source reconnect compatibility proven.
- [x] Native states, independent review, hosted/integrated gates recorded.

No persistence migration, new daemon/API field or deployment. Existing saved UUID
is not a verified daemon incarnation; replacement server at identical UUID/URL is
not detectable here. Already-admitted operations may complete remotely, including
API work awaiting credentials. No automatic replay, durable outcome reconciliation
or cross-handler pending-command persistence is established. Other desktop stores,
direct API callers and global connection/auth task ordering remain outside scope.
Reverting the bounded source/token/handler changes restores previous behavior.

Independent plan review found the omitted AppRoot recovery path and late-error
normalization gap. Root verified both, plus automatic dev-token API replacement.
The plan now includes one active-identity gate, forced recovery coordination and
catch-path ownership checks, with private boundary tests. Review follow-up found
this bounded design feasible. All technical phases are approved under standing
authority. No human manual judgment is needed for these ownership contracts;
native inspection is automated evidence, not user signoff.

## Implementation evidence — baseline

At unchanged production `f8693f23`, private transport characterization reproduced
all five selected behaviors: cached source data survives replacement, delayed
fix response overwrites B, delayed DELETE removes B, old acknowledgement starts
B refresh, and obsolete handler still admits A work. Four test functions (five
cases) failed with nine expected assertions, no timeout acceptance. Command:
`swift test --package-path packages/desktop --filter ConnectionOwnershipTests`.
Log: ignored `.autopod-data/reliability/r04e/baseline.log`. Each fixture closes its
private sessions/peers and joins tasks; no accounts or journals were accessed.

## Implementation evidence — final worker proof

Implementation and tests are frozen at `af40ce59ccd59f3d58db2b39e1209fb564a69366`,
after merging campaign `88a739c5`. Later worker changes are this evidence only.
The baseline is preserved in `ecb9fe9e`; no production code changed in that commit.

PodStore now distinguishes stable `(saved UUID?, endpoint URL)` cache identity from
its configuration epoch. `configure(api:connectionID:)` revokes every old handler;
`disconnect()` retains readable source data while revoking API authority. Internal
`ownership(for:)`/`isCurrent(_:)` carry an immutable store UUID/epoch lease. The
handler captures that lease and checks it before and after API success/error and
store follow-ups. Both app entrypoints use the shared active-identity gate; explicit
recovery calls the same wiring path with a forced generation. No draft behavior,
daemon API or other store ownership contract changed.

Private transport tests prove same-UUID/same-URL retention, UUID or URL changes,
A→B→A, unknown-UUID URL fallback, initial unowned data clearing, delayed REST and
handler results, same-object API reconfigure, disconnect admission, late Goal404
versus current404, direct create/rerun/waiver publication, fleet follow-ups, and
held Kill→Delete. The controlled socket test retains A's EventStream, disconnects
it before B, and delivers old and new callbacks. Old callbacks neither mutate B
nor admit REST; B callbacks work. Gate tests use real stores/handlers with two API
instances on the same URL, repeated observation, successful/failed recovery and
explicit same-API recovery. No ConnectionManager/account initialization is used.

Fork/worker tests hold configuration, resolve, launch and worker branch sync;
replacement stops subsequent calls and pre-launch journal writes. Positive private
launch/series paths check saved request identity, source/digest/branch and 0600
files/0700 child directories. Series response arrays and returned IDs are fenced.
A held token provider explicitly proves the admitted-operation limit: one request
can still be sent after replacement, but no refresh/publication follows. Fixtures
release held providers, close sessions/peers, cancel and join owned tasks, and
remove private journals/defaults. No network accounts, home journals or Keychain.

Commands and results (ignored evidence under `.autopod-data/reliability/r04e/`):

- Initial affected: `swift test --package-path packages/desktop --no-parallel --filter
  'ConnectionOwnership|ConnectionWiring|ConnectionLaunch|PodStoreLifetime|DecisionIdentity|ConfirmedAction|InlineControl|ReplyDecisionRetention|FactWaiver|UnverifiedTermination'`
  with `AUTOPOD_CONNECTION_RENDER_DIR` set to the private evidence `native` folder:
  64 functions, 163 expanded cases, 10 suites, zero skips; exit 0. This preceded the
  campaign merge and final fixture wording/handler-construction adjustment.
- Final frozen source: `AUTOPOD_CONNECTION_RENDER_DIR="$PWD/.autopod-data/reliability/r04e/native"
  swift test --package-path packages/desktop --no-parallel`; exit 0. Swift Testing
  reports **474 tests in 25 suites**, comprising **473 passed functions / 608
  expanded executed cases and one skipped test**. The existing opt-in
  `LiveVillageConnectionTests/configuredDaemonReachesStoresEventsAndBundledVillage`
  was skipped. XCTest: **13 passed, zero failures**. No live-daemon claim.
- `swift build --package-path packages/desktop --product AutopodDesktopExe`: exit 0.
- `npx -y -p node@22 -p pnpm@9.15.4 -c 'pnpm secret-scan'`: exit 0.
- `git diff --check f8693f23 HEAD`: exit 0.
- Local toolchain: Apple Swift 6.3.3, Xcode 26.6 (17F113). Existing AppKit
  accessibility deprecation warnings remain; no compile failures.

The actual production MainView mounts its production DetailPanel in an owned
NSHostingView window. Five raw PNG/AX captures show selected A; disconnected A;
same-source reconnect A; different-source empty fleet/detail before B returns;
and selected B with the same pod ID and different question/options. Each final
image was inspected. Existing “No pods” and “Select a pod” placeholders replace A;
B's card and detail contain no A question/options. Observed host bounds are
1450×792 points. Native `cacheDisplay` omits the sidebar/list vibrancy in this
helper (white sidebar); that region and full application/account switching are
not visually qualified. Relevant fleet/detail data states are visible. There is
no mouse/button activation or OS compositor claim. Production styling was not
changed for the capture. New handlers are constructed on reconnect in the fixture;
working action authority is proven separately by the held transport gate tests.

Receipt `proof.json` and `manifest.json` record exact code revision, commands,
results and SHA-256 hashes of final logs/captures/source. Independent source/proof
review, PR hosted checks and integrated checks remain root-owned pending gates.
No worker PR was opened; no user manual result is inferred.

## Completed integration

Final worker ed02c8ed received independent source/evidence review with no actionable
findings before PR435. Root independently ran64 functions/163 cases/10 suites
and inspected all five root native captures. Both reviewers recomputed the32
manifest hashes without mismatch. PR435 passed general build/test/secret checks
(38809571399) and hosted Swift, renderer and unsigned Xcode build (38809571365),
then merged only into codex/reliability at
`d2a426a26cd038fd9c27dbd66c8e2e9a4ff4002e`.

Root's fresh integrated Swift build and affected run passed64 functions/10 suites
with zero skips (5.436s test execution). Command used --jobs2 --no-parallel and
the complete connection/launch/wiring/lifetime/decision/control/reply/waiver/
termination filter recorded in root-proof.json. Root inspected all five regenerated
integrated PNGs; A retention and empty-then-B content match the scoped expectation.
Sidebar/vibrancy and full account/application limits remain unchanged. All32
worker source/evidence hashes still matched after integration. Verdict PROVEN
for this bounded ownership contract. Evidence is retained in campaign r04e/.
