# Slice 27: complete delivery and merge ownership

Status: PLANNED — implementation is the next authorized phase.
Date: 2026-10-19. Baseline: 9c9d220e44b8175edbf9860d6189b8c74dd96e33.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research: ../research/2026-10-19-pod-manager-delivery-merge.md.

## Outcome and authority

Complete milestone 27 across the manager, validation and approval. Own branch/PR
publication, PR base/create/retry, checkpoint scans, credential parking, merge queue
construction and resumed polling. Split the actual inline delivery lifetimes in the
previous validation and approval owners; moving manager helpers alone is insufficient.
Retain every public signature, status/event/error policy, credential boundary, durable
record, shared object and lifecycle fence. Manager begins at 7,399 total lines.

The standing user goal “the rest of the slices” and roadmap execution authority cover
research, planning, implementation and qualification together. Record the concrete
plan before editing product code, without another approval request. This is one
numbered milestone with three testable phases, not additional helper milestones.
The full goal remains active through all Slice 34 finish gates.

No schema/profile/state/API changes, credential/security policy repair, source replay
or atomicity guarantees, live provider/container execution, PR/main integration or
deployment. Existing fix-cycle algorithms remain 28; controls 29; cleanup resources
30; workspace/recovery 31; admission/series 32. Domain delivery owners receive narrow
callbacks to those responsibilities. No public PodManager or broad dependency bag.

## Current source and concrete decisions

Research inventories 12 complete manager bodies (11 helpers plus retryCreatePr),
four original bindings and the startup resumeMergePolling call. They have no live
manager-dependency or this reads. The four bindings are constructed at distinct
points; their single instances flow into approval, fixes, validation and polling.
startMergePolling captures a generation, coordinator ownership and approval/PR
identity, then fences every asynchronous provider and cleanup effect. Restart begins
polling before later runtime/workspace construction. Preserve this exact startup site.

validation-trigger-workflow.ts has 1,273 lines. The complete successful branch is
lines 890–1123, including publication, PR metadata, validated/readiness/advisory,
fix routing, container stop and deferred auto-approval. The revalidation successful
branch is lines 450–615. Both branches are contiguous statement groups with their
own current error policies. Extract each complete branch, leaving its caller's
original pass predicate and outer try/catch. The trigger caller awaits the owned
phase and then ends normally; revalidation returns await of the owned phase's
original {newCommits,result} value. Each async owner runs synchronously until its
first original await. In particular, no-PR delivery still reaches its original
validated/readiness effects before the original advisory await. This avoids an
additional await inserted between no-PR admission and validated transition.

A formatted temporary preview of this complete-branch split leaves the trigger at
969 lines, including scaffolding and unchanged abort/update-intent logic. Save its
exact recipe; all final source owners and the modified trigger must stay below
1,000 lines. The earlier narrower delivery-only preview was 1,033 lines and is not
the chosen design. Do not move abort/council/rework logic just to satisfy line count.

Approval's current 794-line approveSession body in its 835-line module needs a real
internal boundary. Separate delivery preparation (identity, snapshot, reconciliation,
no-change delivery) from delivery execution (publication/rebase/review/merge/PR retry/
fallback). Keep entry approval policy, normal approved/merging admission and final
cleanup/completion orchestration in approval-workflow.ts. Original internal awaits,
guards and statements remain in order; two explicit structural awaits return stage
results to the entry. A stage result distinguishes an original outer return from
continuation, without changing nested queue/operation returns. No new retry or fence
policy is introduced. Record these structural awaits as intentional extraction
scaffolding rather than claim byte-identical whole approval bodies after splitting.

## Domain source ownership

Create files under packages/daemon/src/pods/:

- delivery-policy.ts: export original formatRebaseConflictReason, resolvePrBaseBranch
  and isSinglePrSeriesPod functions unchanged, for all existing consumers.
- delivery-state.ts: separate createDeliveryProvider, createDeliveryMergeQueue and
  createDeliveryPollingState constructors contain respectively the original wrapped
  prManagerFactory binding, new MergeQueue binding and original coordinator/default
  interval bindings. Return the exact original instances. Invoke each at its old
  construction site; no eager service/provider calls or new timers.
- delivery-scan.ts: createDeliveryScan returns original runPushCheckpointScan and
  getLatestPushFindings functions. Preserve block/escalate/fail-open distinctions,
  scan context and latest persisted push findings.
- delivery-credentials.ts: createDeliveryCredentials returns unchanged
  parkOnCredentialFailure. Retain host_push escalation persistence, service-specific
  reason, awaiting_input transition, resource retention and true return.
- delivery-pr.ts: createDeliveryPr returns original ensurePrBaseBranchOnOrigin,
  pushAndCreatePr and retryCreatePr functions. Preserve ensureRemoteBranch receiver,
  best-effort base publication, feature target/maxDeletions=0, credentials/error
  identity, metadata/fallback reporting and retry admission. The public retry method
  returns the owner promise directly, with no redundant async wrapper.
- delivery-polling.ts: createDeliveryPolling returns original startMergePolling,
  stopMergePolling and resumeMergePolling functions. Constructor does not resume;
  the manager invokes resume at its original site. Preserve source/target-bound
  journal admission/reconciliation, closed disposition, retained resources, review
  gates, same shared queue, interval, feedback deduplication and fix callback.
- delivery-contracts.ts: explicit captured interfaces from actual symbol reads,
  plus provider/queue/poller state types and split approval stage contracts. Reuse
  existing infrastructure and domain contract types/Parameters/ReturnType. Do not
  infer a port from a manager-wide interface or copy the manager dependency object.
- validation-pass-delivery.ts: createValidationPassDelivery returns
  completeValidationPass with original successful-branch statements, local variables
  and early void returns. Explicit per-call context contains podId,pod,profile,s2,
  result,validationSyncOk,attempt,validationConfig,validationRecord. Narrow this port
  is Pick<ValidationWorkflowCalls,'approveSession'>, passed with .call(this,...).
- revalidation-pass-delivery.ts: createRevalidationPassDelivery returns
  completeRevalidationPass with the separate original statements/returns. Per-call
  context contains podId,pod,profile,s2,result,revalDefaultBranch,newCommits,
  validationConfig,validationRecord. Same narrow receiver pattern. Keep its zero
  deletion allowance, swallowed deletion guard, lack of credential parking and empty
  PR screenshots. No unification with trigger policies.
- approval-delivery-preparation.ts: createApprovalDeliveryPreparation returns
  prepareApprovalDelivery. Input is the same podId/options/pod/readiness/actor/
  approvalReason. Move the contiguous original statements from isWorkspacePod through
  the no-change branch. Ready result returns recoveredMerge and the same two local
  publication closures; halted represents the original no-change complete return.
  Keep snapshot/current-row checks, cleanup/completion/dependents for this fast path.
- approval-delivery-execution.ts: createApprovalDeliveryExecution returns
  executeApprovalDelivery. Input includes podId/options/pod/mergingAnchor/s2 plus
  preparation's recoveredMerge/publication closures. Move contiguous statements
  from deliveryOperation through the original main delivery branch. Original outer
  merge_pending returns become halted; nested MergeOutcome/operation returns remain
  unchanged. Return ready only where original final cleanup should follow.

Existing changes are bounded to pod-manager.ts, validation-trigger-workflow.ts,
validation-revalidation-workflow.ts, validation-workflow-ports.ts,
approval-workflow.ts, approval-contracts.ts and test-utils/approval-helpers.ts.
Move the trigger/revalidation Captured aliases into validation-workflow-ports.ts,
pruning only fields no longer read; add the two delivery function ports. Keep explicit
per-call types there or delivery-contracts.ts. Approval entry takes a narrowed Pick
of its prior contract plus preparation/execution function ports. The stage inputs
use narrowed Picks of that prior internal domain contract. Retain that existing
contract as the infrastructure type for test fixture mutation where useful; it is
not a public-manager dependency bag.

No validation-workflow-helpers.ts exists in the live repository. Existing validation
control and public characterization fixtures remain unchanged. Adapt only actual
approval-helpers.ts workflow construction to compose both new stages from its
existing captured object before the entry, retaining mutations made before workflow()
and all existing assertions. New direct fixtures live in test-utils/delivery-helpers.ts
and reuse existing mock/repository factories, rather than scattering infrastructure.

## Construction, receiver and state invariants

Provider wrapper, merge queue and polling coordinator retain their old creation
points. Scan/credential/PR factories must be composed after createCompletionEvents
and createCompletionDiagnostics produce emit/transition references (around :1999),
before later consumers capture their outputs. Their originals were hoisted functions
whose bodies could read these later bindings; capturing them at the old helper
text location would read the temporal dead zone. Constructors only bind references;
this later construction changes no original service call. Preserve all argument
identities, method receivers, dynamic this lookups and callback arities.

Compose polling at the old polling helper/startup section after maybeSpawnFixSession
is initialized. All referenced approval/event/state dependencies then exist; hoisted
cleanup/dependent helpers are safe references. Resume at exactly the old call. Future
fix extraction must retain this startup availability through narrow late-bound calls
if its factory moves after workspace outputs; do not defer or eagerly invoke it now.

Compose validation delivery owners immediately before the corresponding trigger/
revalidation owners, and approval stages immediately before approval entry, with
explicit field lists. Preserve same map/set/queue/provider references for every path.
No per-consumer owner may allocate an alternative queue/coordinator/allowance set.
Remove only imports/captured fields made unused by the extraction.

## Phase 1: freeze qualified baseline and exact recipes

Verify all 2,060 qualified Slice 26 package/script hashes and six root controls.
Save full manager and seven changed predecessor source/fixture files, original
manager bodies/state, selected full validation branches and both approval statement
groups plus entry remainder. Freeze public pod-manager.test.ts bytes and its 1,192
case names/statuses. Reuse predecessor qualification only with explicit matching
source provenance; execute any new baseline characterization before source mutation.
Record allowed statement-group/return/type/await/delegate transforms and complete
expected file recipes. Compare parsed tokens, not a summary list of selected calls.

Automated:
- [ ] Qualified predecessor hashes/root controls and public bytes match.
- [ ] Baseline bodies/state/complete branch and stage recipes saved before edits.
- [ ] Same baseline public suite established with unchanged assertions.
Manual: none for this compatibility boundary under standing continuation authority.

## Phase 2: implement and directly exercise all owned boundaries

Implement the source/wiring above. Add co-located delivery-policy.test.ts,
delivery-state.test.ts, delivery-scan.test.ts, delivery-credentials.test.ts,
delivery-pr.test.ts, delivery-polling.test.ts, validation-pass-delivery.test.ts,
revalidation-pass-delivery.test.ts and approval-delivery.test.ts as coherent suites.
Use a shared actual-repository fixture, controlled external transports and private
filesystem databases; release fake timers, unresolved operations and temp resources.

Direct evidence covers base/series/conflict selection; original state construction,
shared queue serialization and coordinator replacement/stop; scan skip/block/fail-open
and findings selection; credential parking; PR retry admission, preserved credential
identity, deletion error classification, bound ensureRemoteBranch and metadata/order.
Polling covers startup resume with bound intervals, missing history/provider, closed
PR retention, review/source-bound admission, confirmed merge cleanup/event/dependents,
feedback deduplication and ownership invalidation across an in-flight provider wait.

Validation delivery tests separately exercise no-PR synchronous validated/readiness
ordering, existing PR carry-forward, GitHub artifact/ADO metadata selection, trigger
credential/deletion halt versus revalidation guard continuation, fresh stats/waiver
metadata, PR failure still validated, advisory boundary/fix routing/container/deferred
auto-approval and dynamic receiver behavior. Existing public suite remains required
for inherited end-to-end validation/council/retry/recovery behavior.

Approval stage tests exercise no-change halted result, ready preparation with same
publication closures, recovered merge, failed snapshot/resource retention, normal
merge pending/confirmed and failure behavior, entry orchestration and stale identity
across both stage boundaries. Existing 25 direct approval cases stay asserted.
At least three actual private-file SQLite close/reopen cases cover merge_pending
restart admission/retained resources; confirmed merge/completion history; credential
or failed delivery retaining source/resources and unrelated rows. Check integrity/FK.
Real local ledger/snapshot data with synthetic provider receipts does not prove live
GitHub/ADO/Docker/Azure delivery and must be labeled accordingly.

Run unchanged public 1,192 cases, new owner suites, all inherited direct approval
suites, scoped Biome/whitespace and daemon/dependency build/declarations. Compare
supplemental moved-source diagnostics to the original complete baseline; no new
semantic diagnostics. New test/fixture semantics must be clean. Retain first failures;
correct scaffolding/incorrect fixture setup without relaxing original assertions.

AST audit: 12 manager bodies/parameters/defaults, four initializers and startup site
remain equivalent. Both complete validation branch statement sequences match, with
only explicit receiver typing/context plumbing/caller delegation. Approval sequences
match across preparation/execution/entry with declared halted-result and two await
transforms; compare nested returns separately. Audit full manager and all changed/
new module recipes. All other predecessor package/script files and six root controls
stay frozen. Same 73 public members; no delivery algorithms remain in manager or
inline PR/publication/merge algorithms in approval entry/validation callers. New
owners and modified trigger all <1,000 lines. Do not mistake line count for ownership.

Automated:
- [ ] Exact source/state/startup and whole statement-group recipes match.
- [ ] Public 1,192 names/statuses/assertion bytes unchanged and all pass.
- [ ] All new/direct inherited suites pass, including three real SQLite reopen cases.
- [ ] Scoped lint/build/declarations pass; no new source/test semantic diagnostic.
- [ ] Complete delivery owners, same public interface/state references; size exception ends.
Manual: none; no live external acceptance claimed.

## Phase 3: qualify frozen revision and continue the roadmap

Run all 196 inherited affected suites plus new owner suites and missing immediate
collaborators, deduplicated/unfiltered, SKIP_DB_TESTS=0. Save exact paths/command before
execution. Freeze final package/script/root hashes, commit/push implementation, then:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Use pinned Node 22.23.3/pnpm 9.15.4/SQLite 3.49.2 and executable local npx launcher.
Frozen install without fallback or lock change; every Turbo task uncached. Retain only
the inherited task-local 2 MiB root-lint input limit and existing warnings, with no
rule/config/selection/dependency relaxation. Record actual new counts against the
8,793 passing Vitest /538 passing files /35 Node tests predecessor; same ten inherited
gated skips, no new skips. Source changes after freeze invalidate affected proof.

Use prove-work after implementation; record .autopod-data/delivery-merge/proof.json
with claims/results/commands/revision/hash inventories, actual SQLite cases and
limitations. Commit/push qualification docs; check clean local/remote identity and
frozen bytes. Mark 27 complete only after every gate; record research for 28 fix cycles
and proceed. Goal stays active through 34. Final gates remain facade <=1,500 lines,
327-unit/73-public-entry reconciliation, every mutable owner and tested cleanup path,
full frozen uncached qualification and a clean pushed integration-ready revision.

Automated:
- [ ] Complete affected set passes with real SQLite and no new skips.
- [ ] Full frozen uncached validation passes with actual environment/counts recorded.
- [ ] Frozen bytes and clean pushed tested revision verified.
- [ ] Plan/roadmap updated with proved 27 completion and next 28 research.
Manual: none; live production/integration work remains separately scoped.

## Compatibility, cost and rollback

No migration or user-facing behavior change. Original calls/IO, queue serialization,
timer intervals and async owner lifetimes remain. Approval gains two explicit stage
await boundaries, with original fences retained at stage edges; do not claim stronger
concurrency isolation. No additional polling/provider call/retry is introduced.
Revert the manager, changed workflows/contracts/fixture and new owners together.
Predecessor and final hashes plus complete recipes make the bounded diff reviewable.
No unresolved design questions remain.
