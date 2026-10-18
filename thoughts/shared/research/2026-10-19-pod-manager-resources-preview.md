---
date: 2026-10-19T01:55:04+02:00
researcher: Codex
git_commit: 5838a228ece085093fae33e30bd657c237ef91b6
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice30 resource, network, preview, polling and advisory state ownership"
tags: [research, codebase, pod-manager, resources, preview]
status: complete
last_updated: 2026-10-19
last_updated_by: Codex
---

# Slice30 research: resource lifetimes and shared state

## Question and baseline

Locate all remaining resource/network/preview algorithms and mutable state assigned30
in the finite remaining roadmap. Source references are packages/daemon/src/pods/
pod-manager.ts at 5838a228ece085093fae33e30bd657c237ef91b6. Manager is5,375lines with73 public
members.29 is implemented, committed and pushed; expanded qualification is still
running when this report is recorded. This research makes no30 product changes and
does not claim29 complete. Exact whole-body/reference/live/state inventories are
saved under .autopod-data/resources-preview/research-inventory.json and *-before.ts.

## Denial receivers and network teardown

startHaproxyDenyReceiver(:1186–1210) obtains the captured container manager and awaits
streamHaproxyDenials, translating denied SNI/source into original firewall_denied
events. It stores the returned handle in one haproxyDenyHandles Map(:1173). Failures
warn without blocking the pod. stopHaproxyDenyReceiver(:1213–1222) deletes the registered
handle before awaiting stop, and catches/logs transport errors. There is no duplicate
receiver guard or new fencing guarantee in these functions. The imported stream owner
in containers/haproxy-deny-stream.ts parses and filters DENY lines, observes stream
exit/rejection and provides idempotent stream.kill through stop.

destroyPodNetwork(:1228–1236) calls the captured optional networkManager teardown,
warns on failure and rethrows only for strict=true. Callers own the requirement to
kill all bridge endpoints first. NetworkManager is a public manager-file interface
currently also consumed by external infrastructure; source30 bodies need only the
observed narrow captured methods, not the public manager or complete dependency bag.

## Container cleanup and auxiliary resources

cleanupContainer(:1254–1341) is an88-line async function with kill default, optional
assertReleaseAllowed callback and CONTAINER_CLEANUP_TIMEOUT_MS=15_000(:1242).
It uses the captured container identity and lifecycle generation. A missing container
releases live launch PIM only on current-generation kill. With a container, it captures
ownsSharedResources, stops preview only for that ownership and checks release guards
at the original await boundaries. A live beforeContainerCleanup hook races20s only
for owned kill; failures warn. It stops the deny receiver for shared ownership, invokes
kill/stop on the captured target, catches operation failure and races15s. Sandbox id
clears only on confirmed kill and matching current generation/container. PIM and
credential lineage release use the original captured ownership. A timeout may leave
remote cleanup continuing; no stronger isolation or completion proof exists here.
The live fields are launchConfiguration.pim.release and beforeContainerCleanup.

killSidecarsForPod(:1481–1520) re-reads metadata, handles absent manager/row/id map,
executes all kills via Promise.allSettled, logs individual failures and throws an
AggregateError only in strict mode. Optional assertCurrent is checked before and
after; retainMetadata prevents clearing ids. Missing cleanup capability with recorded
ids throws in strict mode. sidecarManager is the original captured instance.

cleanupTestRunBranches(:1527–1579) re-reads metadata and executionForPod, uses live
azureDevOpsAuth.getToken, validates optional ownership at the original boundaries,
and deletes each branch with execFileAsync git push --delete,30s timeout and
imported authenticatedGitEnvironment. It never logs raw provider errors because they
may include authorization headers. Strict missing capability/worktree or unconfirmed
branch deletion throws; non-strict paths log/clear as originally written. Metadata
retention follows the current branches, including the early missing-capability clear.
This function is also called by durable deletion31; no credential or deletion-policy
change is implied by its relocation.

## Preview policy, cache and transport

allocateHostPort(:258–260) chooses10,000–48,999 via Math.random. CONTAINER_APP_PORT
is3000(:263); PREVIEW_AUTO_STOP_MS is10minutes(:280). nativePreviewEmails(:272–277)
reads AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS at invocation and splits comma/space
addresses. hostnameFromUrl/portFromUrl(:5359–5375) retain original invalid URL fallbacks
host.docker.internal/3100 and HTTPS default443/HTTP80.

sandboxPreviewProxies(:1343–1346) maps pod to captured containerId/proxy;
nativePreviewPorts(:1348) separately maps pod to containerId/port/url. The original
tryNativeSandboxPreview(:1356–1388) checks configured emails and exposePort capability,
reuses only matching-container native cache, deletes stale cache, exposes3000 and
records the assigned URL. Missing URL/errors fall back without failing preview.
ensureSandboxPreviewProxy(:1390–1448) retains local URL admission; for sandbox it
requires a container, tries native first, stops any old exec proxy when native succeeds,
resets stale external URLs before allocating a localhost port, reuses matching proxy
or stops its predecessor, parses the port and starts imported startSandboxPreviewProxy.
Returned proxy URL is persisted when different. stopSandboxPreviewProxy(:1450–1465)
deletes native and exec entries before awaiting unexpose/close and catches those errors.
parsePreviewPort(:1467–1475) accepts a safe nonnegative parsed port or returns null.

The imported sandbox-preview-proxy.ts owns an actual Node HTTP server and close
promise; requests delegate through controlled container node exec. It filters
hop-by-hop headers, bounds body size and returns502 on transport errors. Cache and
lifetime orchestration currently live in the manager rather than in that HTTP module.
No new listener/provider operation is performed by this research.

startPreview(:4321–4455), stopPreview(:4457–4474) and previewStatus(:4476–4589) are
three complete public async bodies; none uses this or live deps. Start checks deletion
ownership/container/URL/status, reuses a live supervisor idempotently, otherwise starts
it without awaiting the long-running exec. A stopped container is started before
optional supervisor spawn/health polling; exact200 succeeds, original health timeout
returns the preview anyway. Every successful start schedules auto-stop. Stop clears
timer/preview before validating and stopping the container. Status returns safe defaults
for absent/stopped/unavailable containers; otherwise ensures sandbox transport and
parallel-reads PID/restarts/log tail plus HTTP status. Native external URLs probe
localhost3000 inside the container to avoid host-side Entra401; localhost exec-proxy
URLs use host fetch. PID is separately checked before imported parseStatus combines
results. Preview start/status use the existing injected get/execution callbacks.

## Preview timers and commit polling

previewTimers(:1582) is a per-instance Map. clearPreviewTimer(:1987–1993) clears/removes
one timer. schedulePreviewAutoStop(:1996–2016) replaces the previous timer, deletes
its entry when fired, stops preview then the captured container/target, catches/logs
failure, unrefs and registers the timer. No generation admission is added in this
callback. Existing call sites clear before kill/delete/start/stop transitions.

commitPolling(:1585–1587) is one createPollingCoordinator instance with its original
debug callback; COMMIT_POLL_INTERVAL_MS=60_000(:1589). startCommitPolling(:1896–1979)
captures the original full lifecycle/container/target/worktree/branch/base identity.
Its immediate and interval callback checks registration ownership and that identity
before/after each remote await. It attempts initial HEAD capture once, then runs count
and last-commit probes in parallel with the original starting SHA/base fallback. It
publishes only with current registration and unchanged starting SHA. Sandbox polling
reads live workspaceCheckpointController.poll and emits durability degradation only
while current. stopCommitPolling(:1982–1984) delegates coordinator.stop.

polling-coordinator.ts owns registration intervals and in-flight promises; it unrefs
intervals, serializes work per key while stopped callbacks drain, and lets a replacement
start once its predecessor settles. stop removes authority and clears its interval;
it does not cancel remote work. These exact coordinator semantics are already tested.

## Advisory state, semaphore and deferred cleanup

advisoryRuns(:1633) is the same Map<string,Promise<ValidationResult>> shared with
approval-readiness and advisory-validation. ADVISORY_QA_MAX_CONCURRENCY=1(:1638),
advisoryQaActive=0(:1639) and FIFO advisoryQaWaiters array(:1640) implement the
original semaphore. acquireAdvisoryQaSlot(:1642–1648) increments for available capacity
or enqueues resolve; releaseAdvisoryQaSlot(:1650–1657) transfers directly to the next
waiter or decrements active. There is no independent cancellation queue here.

cleanupContainerAfterAdvisorySettles(:1659–1681) calls assertGuidanceCollected before
looking up the same advisory map. Without an in-flight run it returns cleanupContainer
promise; otherwise it emits the keeping-container activity, attaches cleanup in finally,
logs detached failure and returns an immediately resolved promise. It is intentionally
not an await for advisory completion. Imported advisory-validation.ts installs each
run promise and removes only its own matching registration in finally; semaphore
release is in its nested finally. Approval readiness observes the identical map.
These shared references and asynchronous distinctions define existing ownership.

## Runtime network refresh

refreshNetworkPolicy(:4799–4910) is the fourth public async body, without this.
It first rejects when launchConfiguration is present, preserving immutable launch
policy410. For legacy profiles it selects running local/sandbox sessions of that
profile with containers, merges daemon/profile MCP servers and computes each pod's
runtime/provider defaults. Sidecar bridge IP lookup is per pod. Sandbox uses allowed
hosts plus sandboxEgressRefreshPayload; local uses captured network manager gateway/
build configuration with sidecar IPs, daemon host and explicit port. Both refresh the
appropriate captured container manager. Each pod failure warns and does not reject
other refreshes. It captures profile/provider/account/catalog/network/sidecar/config/
MCP dependencies at manager creation, while launchConfiguration remains live.

## Construction and references

There are25 complete bodies and13 original binding initializers in this scope,
including four pure top helpers,21 closure/public functions, six mutable maps or
coordinator values, semaphore count/FIFO state and constants. All body defaults and
captured references are in the exact inventory below. No function uses dynamic this.
Live reads are cleanup launch/PIM/hook, branch ADO auth, commit checkpoint controller
and refresh launch projection. Captured optional networkManager/sidecarManager retain
their original capture semantics. Per-instance mutable creation is separated by other
existing constructors; startup merge polling currently starts after advisory map and
before commit/preview timer function declarations. Existing hoisted functions refer
to later initialized completion/provider callbacks; constructor timing and callable
availability are therefore part of the current composition, not just text locations.

## Tests and history

Current relevant suites include pod-manager.test.ts(1,192 unchanged public cases),
operator kill/pause, deletion/termination/ownership tests, polling-coordinator.test.ts,
preview-supervisor.test.ts, sandbox-preview-proxy.test.ts, advisory-validation.test.ts,
containers/haproxy-deny-stream.test.ts, docker-network-manager/sidecar tests and runtime-
network-defaults.test.ts. These use local repositories/servers and controlled external
adapters. Live Docker/Azure/provider acceptance remains separately scoped.29's final
qualification must pass before its completion record;30 implementation must follow
its concrete plan. The remaining roadmap assigns workspace/recovery31, admission/
queries32, dependency facade33 and final327-unit/73-member/state reconciliation34.

Related research:2026-10-19-pod-manager-operator-controls.md. Roadmap and29 plan are
in ../plans/. This report is descriptive and introduces no new cleanup, credential,
retry, preview authorization or network-policy behavior.

## Exact declarations

| Kind | Symbol | Lines |
|---|---|---|
| function/method | `allocateHostPort` | 258–260 |
| function/method | `nativePreviewEmails` | 272–277 |
| function/method | `hostnameFromUrl` | 5359–5365 |
| function/method | `portFromUrl` | 5367–5375 |
| function/method | `startHaproxyDenyReceiver` | 1186–1210 |
| function/method | `stopHaproxyDenyReceiver` | 1213–1222 |
| function/method | `destroyPodNetwork` | 1228–1236 |
| function/method | `cleanupContainer` | 1254–1341 |
| function/method | `tryNativeSandboxPreview` | 1356–1388 |
| function/method | `ensureSandboxPreviewProxy` | 1390–1448 |
| function/method | `stopSandboxPreviewProxy` | 1450–1465 |
| function/method | `parsePreviewPort` | 1467–1475 |
| function/method | `killSidecarsForPod` | 1481–1520 |
| function/method | `cleanupTestRunBranches` | 1527–1579 |
| function/method | `acquireAdvisoryQaSlot` | 1642–1648 |
| function/method | `releaseAdvisoryQaSlot` | 1650–1657 |
| function/method | `cleanupContainerAfterAdvisorySettles` | 1659–1681 |
| function/method | `startCommitPolling` | 1896–1979 |
| function/method | `stopCommitPolling` | 1982–1984 |
| function/method | `clearPreviewTimer` | 1987–1993 |
| function/method | `schedulePreviewAutoStop` | 1996–2016 |
| function/method | `startPreview` | 4321–4455 |
| function/method | `stopPreview` | 4457–4474 |
| function/method | `previewStatus` | 4476–4589 |
| function/method | `refreshNetworkPolicy` | 4799–4910 |
| binding | `CONTAINER_APP_PORT` | 263–263 |
| binding | `PREVIEW_AUTO_STOP_MS` | 280–280 |
| binding | `haproxyDenyHandles` | 1173–1173 |
| binding | `CONTAINER_CLEANUP_TIMEOUT_MS` | 1242–1242 |
| binding | `sandboxPreviewProxies` | 1343–1346 |
| binding | `nativePreviewPorts` | 1348–1348 |
| binding | `previewTimers` | 1582–1582 |
| binding | `commitPolling` | 1585–1587 |
| binding | `COMMIT_POLL_INTERVAL_MS` | 1589–1589 |
| binding | `advisoryRuns` | 1633–1633 |
| binding | `ADVISORY_QA_MAX_CONCURRENCY` | 1638–1638 |
| binding | `advisoryQaActive` | 1639–1639 |
| binding | `advisoryQaWaiters` | 1640–1640 |

## Open questions

None about current scope/location/reference ownership. Exact next action after29
qualification is the concrete30 plan for all25 complete bodies/13 initializers,
shared resources, original live/captured semantics, timers, waiters and cleanup paths.
No30 product implementation has started.

## Qualification follow-up — 2026-10-19

29 subsequently passed qualification at the same product baseline:237 affected
suites/5,055 passes/four inherited gates; full frozen uncached pipeline8,898 Vitest
passes/562 passing files/same ten gates plus35 Node script tests. All2,115 package/
script hashes and six roots match. Plan/roadmap mark29 complete. Five milestones
remain30–34. Concrete30 plan is saved at ../plans/2026-10-19-pod-manager-resources-preview.md;
next phase is its implementation under standing continuation authority. No30 product
change was made during29 qualification, and this does not mark the full goal complete.
