---
date: 2026-10-19T10:32:53+02:00
researcher: Codex
git_commit: 33a5fc9c1d945a95e9b213df5499f07138a3d78f
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice32 admission, queries, memory workspaces and dependent series ownership"
tags: [research, codebase, pod-manager, admission, series, memory]
status: complete
last_updated: 2026-10-19
last_updated_by: Codex
---

# Slice32 research: admission, queries and series

## Research question and baseline

Locate every current declaration assigned32 in the finite roadmap, its captured/live
inputs, receiver semantics, persistence and existing tests. The manager is3,096lines
and retains73public members at 33a5fc9c1d945a95e9b213df5499f07138a3d78f. Slice31 implementation is
committed/pushed; its frozen full qualification is running. This descriptive research
does not qualify31 or change product source. All references below use
packages/daemon/src/pods/pod-manager.ts unless another path is named.

The roadmap assigns27 complete function/method bodies to32, including simple public
projections. Their full source and TypeScript-resolved external reference inventory
are retained in .autopod-data/admission-queries/research-inventory.json and individual
*-before.ts files. There are no32-assigned closure binding initializers. Public
contracts/dependency composition remain assigned33; final qualification remains34.

## Native and legacy admission

createResolvedSession(:2085–2166) uses live launchConfiguration and captured account
store/catalog/container factory. It checks configuration availability, current frozen
main account, terminal/streaming capability, agent deny-all policy, sandbox/declared
sidecars and native Goal availability. It calls existing admitComposablePod with the
same repository/events/queue and live configuration read method. Its dependency
reconciliation callback resolves the stored parent and invokes maybeTriggerDependents.
Native Goal initialization follows admission and uses the live goals service.

composable-pod-admission.ts contains the existing immutable admission algorithm. It
validates authenticated intentional rerun/replay, retained parent launch digest and
repository identity, single-PR parent branch and preflight overlap. Native overlap
reads fail closed when a current launch is missing. Only actual pods.id collisions
retry, at most ten attempts. Inserted data comes from the frozen configuration and
includes source binding, provider account, options, references and actor metadata.
Its afterInsertCommitted callback emits created/overlap then reconciles the first
parent or enqueues a root. It does not resolve mutable presets after admission.

createSession(:2167–2550) is the full384-line legacy path. With launchConfiguration
present it rejects the old API with410. It requires a matching human actor for
intentional rerun, consults the durable rerun receipt first, reads profile/PAT/provider
preflight, normalizes old/new parent fields and enforces single-series branch identity.
It resolves pod options once, applies skip-validation and interactive capability/
sandbox warm-image/streaming/network gates, unions explicit and auto sidecars and
checks privileged trust. It derives reference repositories. Unlike native admission,
legacy overlap inspection exceptions are logged and treated as no conflicts; actual
block policy refuses before insertion. Every UNIQUE constraint error is retried up
to ten attempts in this original legacy path, rather than native's ID-only predicate.

Legacy insertion retains provider snapshots, branch safety/defaults, immutable creation
metadata, trimmed handoff/spec context/PIM group fallback, token budget, reference/
schedule/dependency/series/touches/sidecar/approval fields. Interactive non-linked work
is moved away from the base branch. Publication emits created then optional overlap;
dependent requests do not enqueue immediately. Repository afterInsertCommitted owns
publication where available, otherwise publication is immediate. These differing
native/legacy admission and failure policies are current source, not interchangeable.

pod-repository.ts:739–758 executes the publication immediately outside a transaction;
inside one it captures task execution identity and setImmediate checks database open
and committed identity before effects. Existing createUnitOfWork is spread into the
repository(:738). Immutable series admission in configuration/series-launches.ts uses
one resolution plus one complete DAG transaction/receipt, calling snapshots.admit and
the supplied manager create callback for each sealed configuration. Request replay
precedes admission readiness, while changed request digest is rejected. This remains
an existing configuration collaborator outside the manager bodies assigned32.

## Execution, credential and injection projections

executionForPod(:814–825) reads live launchConfiguration; a retained launch projects
execution settings. A digest without configuration throws SNAPSHOT_CORRUPT rather than
falling back to profile; legacy uses captured profileStore. executionCredentialsFor
(:826–837) reads the live scoped credential adapter and refuses credential references
without that adapter. injectionsForPod(:844–848) removes daemon defaults for frozen
launches and returns the originally captured daemon configuration for legacy work.

resolveGitCredential(:856–873) reads live azureDevOpsAuth for ADO and live githubAuth
for GitHub, requiring a parseable exact github.com repository host. It never reads
legacy profile PATs. These closure functions are consumed by already extracted
provisioning/provider/validation/operator/workspace owners. They currently are hoisted
functions; early constructors only capture them. Startup resumeMergePolling occurs
at:1178 before the later dependent declaration. Constructor/effect timing and live
fields are visible parts of the current composition.

getLaunchConfiguration(:2082–2084) returns live read or null. Deployment projection
(:2818–2830) reads stored pod/launch, checks live capabilities before and after awaited
credential vending, and falls back to execution deployment only as currently written.
getInjectedMcpServer(:2832–2847) requires running only on native path, checks capability
before/after scoped HTTP vending, returns its native result directly and otherwise
looks up this.getInjectedMcpServers after the await. That dynamic lookup matters if
the receiver method changes while the capability check is pending. Plural projection
(:2849–2853) merges daemon/profile inputs by name, with profile winning, through existing
injection-merger.ts. Frozen pods receive no daemon defaults and never expose redacted
profile placeholders as a replacement for scoped native vending.

## Memory and analysis workspaces

podMemoryScopeIds(:705–707) deduplicates pod id and multi-parent ids.
approvedMemoriesForPod(:709–715) reads approved pod/parent memories, legacy profile
memories only without digest and approved globals. selectMemoryBriefingForPod
(:717–769) immediately returns empty for interactive/no candidates, chooses reviewer
model from profile/model/default, catches factory failures and calls existing
selectRelevantMemories with captured repositories/logger and original client fields.
The default createProfileAnthropicClient identifier and anthropicClient property are
already recorded inherited supplemental semantic diagnostics in31 baseline comparison;
the public fail-soft test at pod-manager.test.ts:6981 uses an injected throwing factory.
Research records that exact current protocol; it does not correct or claim live ranking.
memory-selector.ts owns deterministic prefilter/ranking/fallback/usage behavior outside
this manager export. project-memory-scope.ts enforces frozen digest/repository/setup
scope and does not widen a native repository into shared profile memory.

createHistoryWorkspace(:2552–2571) JSON-encodes history query into task and calls dynamic
this.createSession with workspace/skip-validation and original creator. The memory
workspace(:2573–2606) reads live memoryRepo approved global/profile entries, formats
path/rationale/content and delegates through dynamic createSession. On native daemons
the current legacy createSession gate still applies to these helpers.

getProjectMemoryScope(:2757–2759) reads live launch. getLaunchMemoryContext(:2760–2781)
requires captured getReviewerExecutor(pod,'memory'), obtains captured reviewer profile
and live project scope, and returns a reviewer closure joining system/user prompt with
20s timeout. It returns stdout unchanged. Its nested async generateText uses the
executor selected for that context; later adapter changes do not replace that capture.

## Dependents, series and read queries

maybeTriggerDependents(:1459–1567) enumerates parent dependents and admits queued or
exact cascade-failed marker rows. It handles multi-parent/legacy ids and missing parents
as not ready. Single PR, same branch and waitForMerge require complete; other paths
accept validated/approved/merging/merge_pending/complete. Native frozen base binding
wins; otherwise shared/single/wait-for-merge uses original parent base or main, with
classic stacked using first parent's branch. Healing emits status_changed before base/
dependencyStartedAt update and enqueue. No extra deduplication receipt is introduced.

rehydrateDependentSessions(:2867–2932) is its separate startup algorithm. It visits
queued dependents once and accepts the five success states except single/shared branch
must be complete. In particular its allParentsDone predicate does not separately
require complete for waitForMerge; waitForMerge participates later in base selection.
It preserves a frozen base, updates timestamp and enqueues directly; missing parents
are skipped, and enqueue/update failure is logged. The two current policies differ.

deleteSeriesWithCascade(:2934–2950) requires a nonempty stored series, sequentially
calls dynamic this.killSession where canKill then dynamic this.deleteSession for each
pod. Each failure is logged and processing continues; completion log does not promise
all remote resources were deleted. Both lookups stay live across prior awaited work.

getSession/listSessions/getSessionStats/getSeriesPods are direct stored projections
(:2805–2807/:2855–2865). getValidationHistory(:2952–2956) checks pod exists first then
uses captured optional validationRepo or empty array. These methods currently have
their original public signatures and repository object identity semantics.

warnIfSinglePrSeriesMissingSeriesMeta(:269–281) only logs missing series title/purpose
for single-mode series; complete validation/revalidation owners capture it. mergeOverrides
(:284–292) is a per-call Map merge by findingId, preserving first insertion order with
latest value. Existing validation/operator owners capture it. Neither owns ongoing
mutable state, timers or remote cleanup.

## References and receiver/construction inventory

Live dependency fields are launchConfiguration, githubAuth, azureDevOpsAuth and
memoryRepo. Captured repositories, account/catalog/profile/container services, queue,
logger, daemon config and existing domain functions remain distinct ports. Four named
bodies use dynamic this: createHistoryWorkspace/createMemoryWorkspace(createSession),
getInjectedMcpServer(getInjectedMcpServers) and deleteSeriesWithCascade(killSession,
deleteSession). Nested publication callbacks, optional adapter method call receivers,
native Goal initialization and preserved async return behavior are part of current code.
No32 algorithm starts an owned persistent timer/map/semaphore. Dependency rehydration's
Set and override merge Map are per-call local data; repository publication schedules
its existing post-transaction callback and is not a new owner in this slice.

Existing owners consume hoisted helpers before their source declaration. The current
full constructor and startup sequence is saved in before-manager.ts; each helper's
external resolved identifier origin, direct deps reads and this properties are saved
in research-inventory.json. Unresolved inherited reviewer factory is also recorded
above rather than silently excluded from semantic accounting.

## Existing tests and related artifacts

pod-manager.test.ts contains the unchanged1,192 public cases, including fail-soft
memory startup(:6981), overlap warn/block(:7867), dependent rehydration(:10707 onward),
authenticated reruns(:11773 onward) and native createResolvedSession fixture boundaries
(:29921/:30556). Existing focused tests include composable-pod-admission.test.ts,
configuration/series-launches.test.ts, project-memory-scope.test.ts,
memory-selector.test.ts, preflight.test.ts, provider-preflight.test.ts and
dispatch-preflight-ledger.test.ts. Local SQLite snapshots/receipts/repositories and
controlled provider/container/Git adapters are the established boundaries; source
inspection alone does not claim new test executions or paid/live provider acceptance.

Related: ../plans/2026-10-18-pod-manager-remaining-roadmap.md;
2026-10-19-pod-manager-workspace-recovery.md; Slice31 plan and
.autopod-data/workspace-recovery qualification evidence. Scope32 is all27 bodies;
33 owns stable contracts/facade composition and34 reconciles all327baseline units,
73public members and mutable owners against final frozen qualification.

## Exact current declarations

| Symbol | Lines | Live dependency fields | Dynamic receiver calls |
|---|---|---|---|
| `warnIfSinglePrSeriesMissingSeriesMeta` | 269–281 | none | none |
| `mergeOverrides` | 284–292 | none | none |
| `podMemoryScopeIds` | 705–707 | none | none |
| `approvedMemoriesForPod` | 709–715 | none | none |
| `selectMemoryBriefingForPod` | 717–769 | none | none |
| `executionForPod` | 814–825 | launchConfiguration | none |
| `executionCredentialsFor` | 826–837 | launchConfiguration | none |
| `injectionsForPod` | 844–848 | none | none |
| `resolveGitCredential` | 856–873 | azureDevOpsAuth, githubAuth | none |
| `maybeTriggerDependents` | 1459–1567 | none | none |
| `getLaunchConfiguration` | 2082–2084 | launchConfiguration | none |
| `createResolvedSession` | 2085–2166 | launchConfiguration | none |
| `createSession` | 2167–2550 | launchConfiguration | none |
| `createHistoryWorkspace` | 2552–2571 | none | createSession |
| `createMemoryWorkspace` | 2573–2606 | memoryRepo | createSession |
| `getProjectMemoryScope` | 2757–2759 | launchConfiguration | none |
| `getLaunchMemoryContext` | 2760–2781 | launchConfiguration | none |
| `getSession` | 2805–2807 | none | none |
| `getDeploymentConfiguration` | 2818–2830 | launchConfiguration | none |
| `getInjectedMcpServer` | 2832–2847 | launchConfiguration | getInjectedMcpServers |
| `getInjectedMcpServers` | 2849–2853 | none | none |
| `listSessions` | 2855–2857 | none | none |
| `getSessionStats` | 2859–2861 | none | none |
| `getSeriesPods` | 2863–2865 | none | none |
| `rehydrateDependentSessions` | 2867–2932 | none | none |
| `deleteSeriesWithCascade` | 2934–2950 | none | killSession, deleteSession |
| `getValidationHistory` | 2952–2956 | none | none |

## Open questions

None about current32 source assignment/reference ownership. Next authorized phase is
a concrete32 plan after31 qualifies, covering all27 bodies, native/legacy admission,
post-commit publication, frozen inputs, query credential checks, four dynamic receivers
and distinct dependent/restart policies. No32 product source changes are made here.

## Follow-up Research — 2026-10-19 qualification

Slice31 completed on the exact researched implementation33a5fc9c, with all2,169
package/script hashes and six root controls unchanged. Full uncached qualification
passes9,002Vitest cases/587passing files plus35Node script cases, same ten inherited
gates. No32product edits occurred during research. This artifact remains descriptive;
next is the concrete32plan under the standing grouped approval.
