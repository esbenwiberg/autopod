---
date: 2026-10-19T11:28:10+02:00
researcher: Codex
git_commit: 0501aa6826dc80d0a42e74a866f233cd3de76e8b
branch: codex/pod-manager-workspace
repository: autopod
topic: "Slice34 complete baseline inventory, mutable ownership and final qualification evidence"
tags: [research, codebase, pod-manager, final-qualification, ownership]
status: complete
last_updated: 2026-10-19
last_updated_by: Codex
---

# Slice34 research: final inventory and qualification

## Research question and current source

Locate the complete original327unit inventory and all current owner/contract/composition
evidence, manager-created mutable bindings and final regression gates after33. Source
is 0501aa6826dc80d0a42e74a866f233cd3de76e8b. Slice33is PROVEN on this exact frozen implementation:
manager1,421lines, same73runtime members/72declared public protocols, public body max10,
no residual algorithms/broad domain manager-type dependencies/new runtime cycle.
No final34completion or integration/deployment is implied by that33verdict.

Current33qualification:1,192unchanged public assertions;822direct cases/99suites,
including13new facade/port cases and two actual SQLite reopens. Expanded308suites pass
5,471cases/four identical inherited gates. Full frozen uncached9,053Vitest pass/600files,
35Node cases and same ten inherited skips. All2,199package/script hashes and six root
controls match; Node22.23.3/pnpm9.15.4/SQLite3.49.2; frozen install without fallback,
Turbo7/11/15groups uncached. Evidence:.autopod-data/facade-composition/proof.json.

## Complete original inventory

The finite roadmap in ../plans/2026-10-18-pod-manager-remaining-roadmap.md contains
exactly327table entries, parsed with kind/name/original line range/assigned milestone
and a stable1–327row id. Original source is local Git commit
ecc324ca4a403d49397dd63cecb1a881e653ad06, packages/daemon/src/pods/pod-manager.ts.
The complete16,521line baseline was read from that commit, not reconstructed from
today's smaller module or current tests. Saved source is roadmap-baseline-manager.ts.

research-inventory.json stores all327rows and current declaration candidates from
non-test pods modules.325named entries have candidates. The two display-only entries
are the original captured collaborator destructuring(row73) and startup expression
resumeMergePolling()(row193); they have actual baseline AST nodes rather than a
same-name declaration. Current declarations, full text and line ranges are saved in
current-declarations.json. These are complete lookup leads, not a finished owner map.

Research fingerprints compare original function-body tokens after type erasure,
variable initializer tokens and interface/type tokens to candidates. Token normalization
preserves string/literal values and normalizes trailing commas/formatting.319entries
have exact routing matches. This does not by itself prove capture/live dependency
identity, argument/default timing, actual owner reachability or cleanup coverage.
Those still require full recipes, wiring and tests in the final audit. The first
research fingerprint used whitespace stripping and was replaced by this stronger
token comparison; no product source changed and the earlier research log remains.

Eight entries require explicit composition/split/shorthand reconciliation rather
than a whole-body name match:

| Row | Original entry | Existing source/evidence location |
|---|---|---|
|73|captured manager collaborators destructuring|pod-manager.ts composition;33exact109statement audit|
|193|resumeMergePolling();|pod-manager.ts startup;delivery-merge polling startup recipes and33audit|
|258|processPod|agent-process-workflow.ts plus provisioning/completion owners;23/24/25whole stage/body recipes|
|262|approveSession|approval-workflow.ts plus approval-delivery-preparation/execution.ts;26/27full recipes|
|275|triggerValidation|validation-trigger-workflow.ts plus validation-pass-delivery.ts;20/27recipes;33proxy adapter preserves five arrows|
|276|revalidateSession|validation-revalidation-workflow.ts plus revalidation-pass-delivery.ts;20/27recipes|
|279|touchHeartbeat public shorthand|pod-manager-facade.ts original reference;agent-activity.ts owner;33actual identity test|
|282|getReviewerExecutor public shorthand|pod-manager-facade.ts original reference;reviewer-context.ts owner;33actual identity test|

These locations describe existing partitions. Final34still must substantiate complete
coverage for each partition and every remaining row; a current facade delegate alone
cannot prove the original workflow algorithm moved in full. Multiple candidates with
matching bodies need the actual imported/returned/consumed owner, not arbitrary first
name selection. Types and intentionally retained composition need explicit owner
justifications. execFileAsync remains the original module-level promisify(execFile)
composition adapter, with exact initializer/lifetime verified33.

## Mutable ownership leads

mutable-state-research.json records26manager-created collection/counter/coordinator/
timer/subscription bindings from original inventory rows, with initializer text,
current owner candidates and existing suite paths. The two polling coordinators are
included explicitly through original createPollingCoordinator calls; syntactic Map/
Set-only scanning would miss their registrations/running maps and intervals.

| Original binding | Baseline row | Existing candidate owner suites |
|---|---|---|
|`hostFetchRetryTimers`|79|workspace-host-fetch-retry.test.ts|
|`mergeQueue`|120|delivery-state.test.ts|
|`haproxyDenyHandles`|121|resource-denials.test.ts|
|`maxCredentialLineageByPod`|122|provider-attempt-context.test.ts|
|`sandboxPreviewProxies`|140|resource-preview.test.ts|
|`nativePreviewPorts`|141|resource-preview.test.ts|
|`previewTimers`|148|resource-preview-timers.test.ts|
|`commitPolling`|149|resource-commit-polling.test.ts|
|`mergePolling`|151|delivery-state.test.ts|
|`validationAbortControllers`|153|Inspect composed owner/underlying primitive|
|`attemptExtensionRuns`|154|Inspect composed owner/underlying primitive|
|`infrastructureResumeRuns`|155|workspace-recovery-state.test.ts|
|`artifactResumeRuns`|156|workspace-recovery-state.test.ts|
|`artifactCompletionRuns`|157|workspace-recovery-state.test.ts|
|`coordinateInteractiveCompletion`|158|workspace-recovery-state.test.ts|
|`pauseIntents`|159|operator-state.test.ts|
|`activeAgentRuns`|160|agent-run-registry.test.ts|
|`activeAgentRunResolvers`|161|agent-run-registry.test.ts|
|`advisoryRuns`|164|resource-advisory.test.ts|
|`advisoryQaActive`|166|resource-advisory.test.ts|
|`advisoryQaWaiters`|167|resource-advisory.test.ts|
|`pendingUpdateFromBaseIntents`|171|Inspect composed owner/underlying primitive|
|`forceWithLeaseAllowances`|172|workspace-recovery-state.test.ts|
|`lastEventWriteAt`|173|agent-activity.test.ts|
|`stuckPodWatchdog`|176|workspace-watchdog.test.ts|
|`unsubscribeWakeRecovery`|177|workspace-watchdog.test.ts|

These paths are coverage leads. Suite existence or an executed test count does not
prove cleanup. Final audit needs actual creation/consumer identity, success/failure/
replacement/stop release assertions and exact retained limits for every binding.
External injected services/maps/queue callbacks are distinct caller-owned ports;
per-call Maps/Sets in policy/readiness computations are ephemeral local data. These
must not be silently treated as additional manager-owned global trackers or excluded
without stating ownership. No new mutable state was created by33facade assembly.

polling-coordinator.ts:14–15 owns registrations and running Maps. start stores an
unrefed interval then ticks; stop deletes registration/clears interval. Pending
operation finally releases only its own running entry and admits a replacement after
the old operation settles. stop does not promise to abort an already running remote
operation. Existing polling-coordinator.test.ts covers drain/replacement, failure/
other-key progress and stopped/superseded scheduled work. This research inspected
that primitive; the final audit still traces its commit/merge owner construction.

Other recorded original limits persist:watchdog stop clears subscription/interval but
does not drain dispatched work; host fetch retries clear on replacement/fire without
new cancel-all behavior; deletion has one25s whole-operation deadline and existing
late-operation limits; coalescing is in-process, not new durable replay. Ownership
proof must describe the actual existing guarantee and test, not broaden it.

## Existing proof chain and final source

The research inventory found32predecessor proof.json artifacts under .autopod-data/.
Most use verdict PROVEN; workspace-preservation explicitly qualifies its verdict to
the approved local compatibility contract. Those historical verdict strings are
context, not substitutes for checking final source/hash/owner/default/reference scope.
33's separately inspected proof is now also PROVEN. Each prior numbered slice's
research/plan/full recipes/movement/public/direct/frozen pipeline artifacts remain
available under their established responsibility folders.

The current source remains frozen after33. Final file hashes must account for later
qualified edits to earlier modules, such as27's complete validation/approval delivery
partitions and33's type-only bridge/recorder narrowing. Unchanged tests/helpers and
public assertion bytes have explicit predecessor/frozen hashes. Original327units
include public entries and closure/top-level definitions separately, so a shorthand
reference and its function owner must each be reconciled as their own original row.

Current33architecture audit verifies exact three public contracts, all73runtime
members/order/async/defaults,72declared public facade protocols, ten bridge methods,
memory callback equivalence,109construction/startup statements,43original facade
owner/callback references, eight full source recipes and identical erased runtime for
the two narrowed domain consumers. Only public entry/contracts/index name public
manager types. New runtime edges are manager→facade→call adapter, without a new cycle.
That is concrete architecture evidence; it does not finish all327ownership rows.

## Final outstanding gates

The roadmap requires a row-by-row delivered owner or explicitly justified retained
composition/projection for all327units; all73public entry ownership/contracts; every
manager-owned mutable state object's single owner and tested cleanup/stop path;
manager<=1,500lines/public bodies<=10/no residual algorithms/no broad domain manager
dependencies; unchanged public characterization plus relevant local database/recovery/
race evidence; final full frozen uncached real SQLite pipeline with frozen install,
same inherited gates/no new skips; final clean pushed revision and source/test hashes.

The full goal remains active until those34gates are actually proven. Current source
is integration-ready only after that audit completes. No PR/main merge, hosted deploy,
paid/live provider/container/cloud acceptance or external messages are authorized by
this research or implied by mock/local evidence. Existing native fix alias and stale
memory reviewer/interface protocol limitations remain documented compatibility scope.

## Open questions

None about where current evidence and original inventory live. Eight split/composition/
shorthand rows and26mutable ownership leads remain verification work, not unresolved
product-design choices. Next authorized phase is the concrete34plan for full source/
recipe/owner/cleanup reconciliation, adding meaningful missing contract assertions if
needed within compatibility scope, then final frozen qualification. No final34product
change, ownership completion claim or full-goal completion is made by this research.
