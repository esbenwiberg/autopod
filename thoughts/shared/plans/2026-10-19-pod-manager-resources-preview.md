# Slice30: complete resource, network and preview ownership

Status: COMPLETE — full frozen qualification passed; goal continues through34.
Date:2026-10-19. Source baseline:5838a228ece085093fae33e30bd657c237ef91b6.
Branch:codex/pod-manager-workspace.
Worktree:/Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research:../research/2026-10-19-pod-manager-resources-preview.md.

## Outcome and authority

Move all25 complete resource/policy/preview/network bodies and13 original binding
initializers assigned30, with the original shared lifetime and cleanup semantics.
Manager starts at5,375lines/73public members. Allfour public preview/network commands
become thin delegates. Each denial/proxy/native-port/timer/poller/advisory state has
one explicit per-instance owner. No helper-only subset completes this milestone.

Standing “the rest of the slices” authority covers the established research→concrete
plan→implement→qualify phases with commit/push checkpoints; no repetitive approval.
29 is currently frozen/pushed and qualifying when this plan is written. Do not alter
product30 until29 passes; update this checkpoint after29 proof. Five milestones30–34
remain once29 is qualified. Full goal remains active until34's architectural and full
regression gates. No PR/main/deploy or live provider/container operations are included.

Research resolves scope, actual live/captured references, state construction and all
function defaults. Preserve existing behavior, including original timeout/late-cleanup,
resource ownership captured before awaits, native/proxy cache differences, strict
metadata branches, advisory detached cleanup and preview timer admission. No new
isolation/termination/replay/cleanup/credential/network policy. Workspace/recovery31
and admission/query32 algorithms remain called through narrow original callbacks.

## Owner design

Create eleven source modules under packages/daemon/src/pods/. Full original bodies,
parameters/defaults and binding initializers are extracted without algorithm edits.
No file approaches1,000lines; contracts stay narrow and use existing domain types.

1. resource-policy.ts: unchanged allocateHostPort, nativePreviewEmails,
   parsePreviewPort, hostnameFromUrl and portFromUrl; unchanged CONTAINER_APP_PORT,
   PREVIEW_AUTO_STOP_MS, CONTAINER_CLEANUP_TIMEOUT_MS and COMMIT_POLL_INTERVAL_MS.
   These primitives move to module scope. Environment/randomness remains read at
   invocation; no mutable process-global cache is introduced.
2. resource-contracts.ts: exact original public NetworkManager interface moves here
   as the stable network protocol; manager imports/re-exports the same name/path API.
   Add explicit observed captured/live interfaces for each owner, reusing existing
   infrastructure, PodExecutionSettings and domain callback types. No PodManager,
   PodManagerDependencies or broad manager bag import. Live ports expose only observed
   launch/PIM release, beforeContainerCleanup, azureDevOpsAuth token and checkpoint poll.
3. resource-denials.ts: createResourceDenials captures original container manager,
   events/logger, creates haproxyDenyHandles and returns original start/stop functions.
   Construct at old map site before createReadinessRefresh. No stream opens until
   start is invoked. Stop still deletes registration before awaiting/catching stop.
4. resource-preview.ts: createResourcePreview captures original pod/container/logger,
   creates sandboxPreviewProxies/nativePreviewPorts at their original consecutive map
   site and returns tryNativeSandboxPreview/ensureSandboxPreviewProxy/stopSandboxPreviewProxy.
   Original imported proxy transport stays unchanged. Cache keys/container checks,
   native preference, URL allocation/persistence and deletion-before-close remain.
5. resource-network.ts: createResourceNetwork(live,captured) returns whole
   destroyPodNetwork and refreshNetworkPolicy. Construct at old destroy function
   position; all captured inputs already exist. Preserve exact optional manager
   capture, native immutable-launch410, per-pod sidecar/provider allowlists, sandbox
   vs local firewall construction and per-pod failure isolation. No constructor I/O.
6. resource-auxiliary.ts: createResourceAuxiliary(live,captured) returns complete
   killSidecarsForPod/cleanupTestRunBranches. Construct at old sidecar function site.
   Retain all-settled behavior, optional ownership calls/strict/defaults/metadata,
   token live lookup, exact authenticated git invocation and sanitized failure logs.
   execFileAsync stays a module binding to promisify(execFile), with same behavior.
7. resource-cleanup.ts: createResourceCleanup(live,captured) returns original
   cleanupContainer. Compose immediately after provider-attempt context creation,
   before advisory state and before every fix/delivery factory/startup that captures
   cleanup. Preview/denial functions, ownsLifecycle, credential lineage and repo/
   manager/logger are then initialized. Factory only captures references; its original
   full async body is lazy. Move no call/await and add no wrapper promise. Original
   PIM/hook fields remain live. Retain20s memory/15s operation races and all release/
   guard/late-operation behavior. Export timeout via resource-policy for existing
   provider/agent construction as before.
8. resource-preview-timers.ts: createResourcePreviewTimers captures original preview
   stop/container/logger, creates previewTimers at its old site and returns original
   clearPreviewTimer/schedulePreviewAutoStop. Timer callbacks retain original captured
   arguments, entry deletion, order/catches/unref. No extra generation policy or timer.
9. resource-commit-polling.ts: createResourceCommitPollingState(logger) contains the
   exact original createPollingCoordinator initializer/debug callback, constructed at
   its old site immediately after preview timer state. It returns that coordinator.
   createResourceCommitPolling(live,captured) returns unchanged start/stopCommitPolling,
   composed at original start-function site after unchanged resumeMergePolling startup.
   Captures original coordinator, repo/container/logger/activity callback; checkpoint
   controller remains live. No immediate poll until start is called. Existing startup
   delivery polling does not call commit polling; capture by event owner remains later.
   Existing polling-coordinator.ts owns serialization/current-registration draining.
10. resource-advisory.ts: createResourceAdvisoryState creates original advisoryRuns,
    MAX_CONCURRENCY=1, active=0 and FIFO waiters at the old advisory map site, returns
    same map and full acquire/release bodies. No copied tracker/getter-backed counter.
    createResourceAdvisoryCleanup(captured) returns unchanged deferred cleanup, composed
    immediately after createCompletionEvents when activity callback is initialized,
    before readiness uses the same advisory map. It captures assertGuidanceCollected,
    actual map, cleanupContainer and logger/activity. No constructor operations or
    new drain promise. Approval readiness/advisory-validation retain that exact map.
11. resource-preview-controls.ts: createResourcePreviewControls(captured) returns
    complete startPreview, stopPreview and previewStatus. Compose before public return
    after timer/transport/execution references exist. No dynamic this. Retain deletion
    admission, supervisor/health behavior and native exec vs host fetch status probes.

Only pod-manager.ts changes among qualified predecessor package/script files. Existing
infrastructure algorithms and tests stay unchanged. Re-exported NetworkManager retains
identical methods/optional/signatures; external imports need no edit. Four public
signatures/defaults/return values retain thin promise-returning delegates. Manager
imports policy helpers/constants for existing provisioning/provider/agent composition.
Original per-instance map/coordinator/semaphore initialization order is retained; only
pure primitive locations and effect-free factory bindings change. No mutable resource
is created twice. No dynamic receiver exists in these25 functions.

## Phase1: exact baseline and recipes

Require29 PROVEN first. Verify its2,115 final package/script hashes and six root
controls. Save full manager,25whole bodies/defaults,13binding initializers, network
interface, references/live/captured/state order and complete expected twelve-file
recipes. Freeze unchanged public assertion bytes; reuse29's1,192-case JSON only with
matching qualified source/test provenance. Allowed transforms are imports/exports,
explicit domain types, effect-free factory scaffolding and construction/thin delegates;
no original algorithm/default/await/error-policy change.

Automated:
- [x] Qualified29 proof/hashes/root controls/public provenance match.
- [x] Whole source/reference/initializer/network interface/full recipes recorded.
Manual:none for bounded local compatibility under standing authority.

## Phase2: complete lifetime ownership and contract evidence

Implement all eleven source modules and manager wiring. Add co-located suites for
policy, denials, preview cache, network, auxiliary cleanup, container cleanup, timers,
commit polling, advisory state/deferred cleanup and preview controls. Shared fixture
in test-utils/resource-helpers.ts reuses native repository/test infrastructure; other
predecessor test/helper bytes stay fixed. External adapters and auth remain synthetic.
Actual local disposable SQLite/HTTP/stream boundaries are used where practical.

Policy covers ports/random bounds, environment invocation, parsing and URL fallbacks.
Denials test native controlled stream and event translation, stop/deletion/idempotence
and warned startup/stop failure. Preview tests native matching/stale cache, no URL/
expose failure fallback, proxy re-use/replacement/close, native unexpose and URL
persistence using a real disposable local proxy where useful. Preserve current dual
cache behavior; do not repair it under this rewrite. Every opened listener is closed.

Network tests immutable live launch refusal, disabled/empty selection, per-pod local
bridge/sidecar/gateway host-port inputs, provider runtime defaults, sandbox payload and
one-pod failure isolation. Auxiliary tests absent manager/data/capability, all-settled
strict failures, retained metadata, ownership callbacks and live ADO token replacement.
Git branch deletion uses controlled process adapter or disposable local git remote;
no real ADO/GitHub push or credential exposure. Sanitized logs retain no raw token/error.

Cleanup tests exact kill/stop and callback/denial/preview ordering; no-container PIM;
failed/late/timed-out operations;20s memory hook;15s cleanup race; replacement lifecycle
or container during deferred operations; sandbox conditional id clear; live PIM/hook
replacement and original lineage release. Preserve original captured ownership and
continuing remote operations; do not assert new atomicity/isolation after timeout.

Timers test replacement/cancellation/firing/entry cleanup/unref/caught failure and zero
owned remaining timers. Commit tests original immediate capture, start-SHA/base fallback,
parallel count/time, sandbox checkpoint degradation/live replacement, stop/restart with
old in-flight callback, changed generation/container/target/worktree/branch/base/SHA and
deleted-pod authority. Real createPollingCoordinator instance supplies actual interval
and promise tracking. Pending probes settle and all timers stop, including failure cases.

Advisory tests per-instance/shared map identity, FIFO capacity1 transfer, failure release
and no waiter leak after controlled runs drain. Deferred cleanup rejects guidance before
resource effects; no-run returns cleanup promise; tracked-run returns immediately and
cleanup occurs only after its settlement, for success/rejection, with caught detached
cleanup failures. Use actual advisory-validation/readiness integration where practical;
original19 ownership/public suites remain required. Preview commands test admission,
live-supervisor idempotence, stopped restart/health deadline, auto-stop scheduling,
stop ordering and safe status/native internal probe/local host fetch paths.

At least three actual private-file SQLite close/reopen cases cover persisted preview
URL/resource metadata, confirmed cleanup vs retained resource identity, and guarded
poll observations or sidecar/test-branch metadata. Compare integrity/FK and unrelated
rows. These test actual local state boundaries, without live provider/container claims.

Run unchanged1,192 public cases, all new resource suites and all29 inherited direct
operator/fix/delivery/approval suites, plus existing polling/advisory/proxy/network/
denial/cleanup collaborators. Build daemon/dependencies/declarations; scoped Biome and
whitespace; zero semantic diagnostics in new tests/fixture. Compare all changed source
diagnostics with complete original manager, allowing only inherited code/message cases.
Retain first failures; fix scaffolding/fixtures without altering original public tests
or silently repairing unrelated policy.

AST audit all25whole bodies/defaults,13initializers, moved public network interface,
all12 full source recipes and unchanged73member API. Check original map/coordinator/
semaphore construction order, exact shared captures, effect-free constructors, original
startup delivery polling arguments/site and allfour thin delegates. All2,114 other
predecessor package/script files/six roots stay unchanged. Each new source<1,000lines.

Automated:
- [x] Whole bodies/defaults/initializers/network interface/full recipes match.
- [x] Shared ownership/construction/startup and73member/four-delegate API match.
- [x] Public1,192 names/statuses/assertion bytes pass.
- [x] Direct lifetime tests, three real SQLite reopens and cleanup/no-leak paths pass.
- [x] Build/lint/whitespace/new-test semantics pass; no new source diagnostic.
Manual:none for these local compatibility claims; no live external acceptance claimed.

## Phase3: frozen qualification and next responsibility

Expand all237 inherited affected suites with all new resource suites and missing
network/sidecar/denial/proxy/poll/advisory/cleanup collaborators, deduplicated/unfiltered
with SKIP_DB_TESTS=0. Record actual command/path selection before run. Freeze final
package/script/root hashes, commit/push implementation, then run:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Use existing pinned Node22.23.3/pnpm9.15.4/SQLite3.49.2 runner with executable npx.
Frozen install without fallback/lock change; all groups uncached; inherited task-local
2MiB root-lint processing limit/82 warnings only. No config/rule/dependency/selection
relaxation. Record actual delta from qualified29's full result; preserve same ten
inherited gated cases, no new skips, and35 Node tests. Do not infer counts from plans.

Apply prove-work to final implementation with source hashes, actual tested revision,
claims/evidence/commands/results and limits in .autopod-data/resources-preview/proof.json.
Update plan/roadmap only after all gates pass. Research31 workspace/recovery while30
product bytes stay frozen; commit/push docs and verify clean local/remote identity.
Remaining count becomes four(31–34). Full goal stays active through<=1,500-line
composition/facade,327-unit/73-member/mutable-state reconciliation and final34 proof.

Automated:
- [x] Expanded SQLite-enabled regression passes with no new skip.
- [x] Full frozen uncached pipeline passes with actual counts/runtime/gates.
- [x] Proof/hash integrity and clean pushed revision verified.
- [x] Plan/roadmap mark30 after proof; complete31 research recorded.
Manual:none for bounded scope; integration/deployment remain separately authorized.

## Compatibility and rollback

No migration/dependency/state/profile/API policy change. Original complete bodies,
parameters/defaults/awaits/errors/side effects remain. All mutable resource constructors
remain per manager instance at original creation sites, retaining map/FIFO/coordinator
identity shared by existing owners. Pure constants move without services/timers. Factory
bindings perform no operation. Cleanup/timer races retain existing limits and may leave
remote work continuing. Revert manager and eleven owner modules together. No unresolved
design questions remain.

## Qualified predecessor checkpoint — 2026-10-19

29 now PROVEN at5838a228ece085093fae33e30bd657c237ef91b6:237 affected suites,
5,055 passes/four inherited gates; full frozen uncached pipeline8,898 Vitest passes/
562 passing files/same ten gates plus35 Node tests. All2,115 package/script hashes and
six roots match. Source inventory/research above remain exact. Next is30 baseline/
recipe capture and implementation. Standing execution authority applies; goal remains
active through34. This artifact was written before any30 product code.

## Implementation checkpoint — 2026-10-19

All25 complete original bodies/parameters/defaults and13 binding initializers match;
alltwelve full manager/module recipes match. NetworkManager protocol has identical
members in stable resource-contracts with manager re-export. Same73 public members,
four thin public delegates and original startup polling arguments/site remain.
Mutable creation order and exact shared advisory map captures match. Live PIM/hook,
ADO token/checkpoint and immutable launch refusal remain live; other service instances
stay captured. All2,114 other predecessor package/script files/six roots unchanged.
Manager5,375→4,447lines. Eleven new source modules are37–288lines.

Unchanged1,192 public names/statuses/assertion bytes pass. Ten new resource suites,
29inherited direct suites and seven immediate resource collaborators pass355 cases
across46files:51new,130inherited operator/fix/delivery/approval and174existing resource
cases. Four actual private-file SQLite reopen cases cover confirmed sandbox cleanup,
native preview URL/metadata, HTTPS test-branch metadata and owned commit observations,
with integrity/FK and unrelated profile checks. Real local HTTP proxy traffic and
actual denial stream parser/event persistence execute. HTTPS git process effects,
container/Goal/provider/checkpoint adapters remain controlled; no external deletion,
install/provider or live Docker/Azure acceptance. Actual advisory-validation shares
this resource semaphore/map and releases/deletes its run after runner failure; FIFO
waiters, detached guidance/cleanup promises, timers, polling replacement ownership,
cleanup20s/15s deadlines and original late-operation limits are exercised.

Alleleven new test/fixture files have zero semantic diagnostics; all23 changed-source
diagnostics match the original23 baseline. Build/declarations/scoped lint/whitespace
pass. Initial inferred catalog/poll types, unused facade binding, direct runner path,
fixture stored-payload/captured snapshot/logger/target setup, immutable branch field,
health minimum, nonzero preview port and reopened repository lifetime issues were
corrected without changing original algorithm bodies/public assertions. The first
local Git deletion fixture established the existing credential-free HTTPS requirement;
it was replaced with a controlled HTTPS process adapter, preserving that security
policy. No successful real local-remote authenticated branch deletion is claimed.
Named first failures/outputs are retained under .autopod-data/resources-preview/.

Allsource/test bytes are frozen. Evidence includes recipes, movement.json, named
commands/reports/exits, public-comparison.json, baseline-type-comparison.json,
test-types.json and frozen-manifest.json. Expanded/full qualification, final proof,
clean pushed revision and31research remain before30 is complete. Goal active through34.

## Final qualification — 2026-10-19

Verdict: PROVEN for complete local resource compatibility extraction. Tested source:
c00a32d0871721658ef22019955109f478bc3e0c, pushed before full qualification. Evidence:
.autopod-data/resources-preview/proof.json and named commands/reports/scripts/exits.

All253 affected suites pass5,152 cases with four unchanged infrastructure gates.
Full frozen uncached validation passes frozen install without fallback/lock mutation,
lint, build/declarations, typecheck, workspace tests, audit and secret scan.8,949
Vitest tests pass across572 passing files, plus all35 Node script tests. Same ten
inherited full gated cases; no new skip. Actual Node22.23.3/pnpm9.15.4/SQLite3.49.2;
all observed Turbo groups uncached(7/11/15tasks). Inherited task-local2MiB root-lint
processing limit/82warnings retained, with no rule/config/dependency/selection relaxation.
All2,137 final package/script hashes and six root controls match.

The first expanded run hit an unchanged100ms runtime clock assertion at99ms. Its
report/log is retained in affected-first.json/affected.log. The full22-case runtime
suite, all253 affected suites and full uncached pipeline subsequently pass on identical
frozen bytes. No test threshold/source/rule/selection was changed for this failure.
Fixture/scaffolding corrections and original HTTPS/nonzero-port/metadata behavior are
recorded in the checkpoint above; no product-policy repair is hidden in qualification.

All1,192 public names/statuses/assertion bytes match. Final46-suite direct run passes
355 cases:51new across ten suites,130inherited operator/fix/delivery/approval and174
existing immediate resource cases. Four actual private-file SQLite reopen cases cover
confirmed sandbox cleanup, native preview URL/resource metadata, controlled HTTPS
branch metadata and owned commit observations; integrity/FK/unrelated profile checks
pass. Real local HTTP proxy traffic, real denial stream parser/event persistence and
actual advisory owner sharing resource semaphore/map are exercised. Poll/timer owners
stop/drain controlled probes, semaphore failure releases capacity/removes run identity,
guidance prevents premature release and cleanup retains original timeout/late-operation
limits. External effects use controlled container/checkpoint/Goal/provider/HTTPS process
adapters; no real external deletion, messages, paid model, live Docker/Azure/provider
or installation acceptance. No stronger atomicity/replay/isolation/termination claim.

All25whole bodies/defaults,13initializers, exact public network protocol and alltwelve
full source recipes match. Same73 public members/four thin delegates, mutable creation
order/shared advisory captures and original startup polling arguments/site remain.
All23 current source diagnostics match the original23 baseline; eleven new test/fixture
files have zero diagnostics. Manager5,375→4,447lines; eleven new source modules37–288lines.

This completes30. Four milestones remain31–34. Complete31workspace/recovery research
is saved at ../research/2026-10-19-pod-manager-workspace-recovery.md, covering27named
bodies/complete branch arrow/nine initializers,15public commands and three dynamic
receiver paths. Next is its concrete plan before product changes. Goal remains active
through<=1,500line composition/delegates,327-unit/73-member/mutable-owner reconciliation
and34 full proof. PR/main integration/deployment remain separately authorized.
