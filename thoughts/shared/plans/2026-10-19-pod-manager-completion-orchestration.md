# Slice 25: complete completion orchestration and shared transitions

Status: PLANNED — authorized continuation of the remaining-slices goal.
Date: 2026-10-19. Baseline: ab7166dd4ba56679d8dd7667cbd929aaab225e83.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research: ../research/2026-10-19-pod-manager-completion-orchestration.md.

## Outcome, scope and authority

Complete the entire milestone25 responsibility: handleCompletion and composition of
its three existing domain owners; shared termination/guidance/lifecycle guards;
transition/completion/activity event effects; original bounded operator/security
failure reporting. Preserve all15 complete bodies, one constant, the phase type,
all existing callback/await/error/default behavior and constructor argument order.
The manager starts at8,812 lines. Helpers alone do not fulfill this milestone.

The user authorized the remaining roadmap sequence together. Research, plan,
implementation and qualification are evidence checkpoints; no repetitive per-slice
approval. No new product/API/state/schema/credential/security policy, paid/live
provider execution, Docker/Azure acceptance, integration, PR/main merge or deployment.
Completion does not absorb approval26, delivery27, fixes28, controls29, resources30,
recovery/workspaces31 or admission32. In particular,27 still extracts inline validation
trigger/revalidation delivery and reviews its temporary source-size exception.

## Concrete domain owners

Create five internal source files in packages/daemon/src/pods/:

1. completion-diagnostics.ts: original summarizeAgentCompletionBlocker,
   formatElapsedDuration, sanitizeSecurityScanLogValue, sanitizeFailureReason,
   operatorErrorMessage and describeSyncFailure; original20-finding constant and
   OperatorFailurePhase union. Export static functions/type where consumed.
   createCompletionDiagnostics captures only emitActivityError and returns the
   unchanged emitBlockingSecurityScanFindings body, retaining the original cap,
   sanitization, fatal=false flags, omission count and effect order.
2. completion-guards.ts: createCompletionGuards captures the original podRepo and
   nudgeRepo references and returns complete assertExecutionTerminationVerified,
   assertGuidanceCollected and ownsLifecycle functions. No dependency calls occur
   during construction. Preserve missing-pod/deletion/task errors and their order.
3. completion-events.ts: createCompletionEvents captures podRepo/eventBus and the
   exact bumpActivityTimestamp, recordNotReportedMemoryUsage and refreshReadiness
   function references. It returns unchanged emitActivityStatus, emitActivityError,
   transition and emitPodCompletedEvent bodies/parameter defaults. Preserve memory
   reporting before mutation, update/journal order, afterCommit fallback/publication,
   readiness refresh order and original compromised-worktree clearing predicate.
4. completion-workflow.ts has two related constructors. createCompletionOwners
   captures explicit original inputs and contains the three COMPLETE existing
   createCompletionHumanGate/Source/Decision construction statements in their
   original order. Return their exact original function objects. Retain original
   getContainerManager arrow and rework prefix argument. Reuse existing532 lines of
   domain-owned algorithms; do not copy or alter those modules.
   createCompletionWorkflow(live,captured) returns the entire original handleCompletion
   body. Its explicit CompletionCalls this type contains only triggerValidation.
   Manager delegates via completionWorkflow.handleCompletion.call(this,podId),
   preserving late receiver callback reads and exact validation argument arity.
   Capture the original artifactCompletionRuns instance and finalizeArtifactPod;
   preserve the original promise microtask, coalescing key and matching-promise cleanup.
5. completion-ports.ts defines only the observed structural inputs and callback types
   for those constructors. Use existing domain types and Parameters/ReturnType of
   existing domain factories when useful; no PodManager/PodManagerDependencies
   imports, derived broad bags or public-manager receiver ports. The workflow live
   object exposes only launchConfiguration.read/goals.get; other inputs are captures.

Agent-execution-contracts.ts currently copies OperatorFailurePhase. Replace only that
copy with a type re-export/import from completion-diagnostics.ts so the same union has
one owner and existing agent imports remain valid. The original manager alias also
becomes a type import. No alias value is passed through runtime composition. The known
original supplemental validation-phase type diagnostic remains out of compatibility
scope; this type relocation does not change the union or original assignments.

## Construction and source preservation

Guard construction follows the initial infrastructure destructure, with pod/nudge
references already initialized. Move no resource/service operation into constructors.
Static diagnostics imports are available at all earlier failure callbacks.

Construct completion events immediately after agent-activity construction (original
:2259). At that point the exact liveness/memory callbacks exist and readiness service
(:1519) is initialized; refreshReadiness is a hoisted function declaration. Construct
the scan reporter after events, capturing its returned error emitter. These functions
must exist before validation controls (:2845) and other earlier constructor captures.
Moving a hoisted helper to a later uninitialized const is not allowed.

Replace the original three completion-owner initializations (:3358–3399) with one
createCompletionOwners call at that same point, after workspace preservation. Its
captured functions/objects are the original ones and existing constructors remain
side-effect free. Do not move final artifact construction earlier: finalizeArtifactPod
is created at:3842. Compose completion entry just before the public object, after
artifact finalization and all owner results exist. Thus no lazy forwarder or extra
promise is needed to access a not-yet-initialized artifact finalizer.

Remove original bodies/constant/type from manager, add imports and exact composition,
and preserve the thin public signature. Other source and public assertion files stay
unchanged. Every new source module remains below1,000 lines. Existing artifact map
construction/ownership stays assigned31; the entry uses the same passed map. Existing
status enum, readiness, artifact finalizer, three completion modules, state machine,
provider/runtime and resource policies are not rewritten in this milestone.

## Phase 1: qualified baseline and complete characterization

Verify all2,038 qualified Slice24 package/script hashes and six root controls before
editing. Freeze the complete public manager file and1,192 case names/statuses. Reuse
Slice24's qualified public-after report only with explicit unchanged-hash provenance.
Save full manager, agent-execution-contracts,15 bodies, constant/type and all three
existing constructor statements. Save AST actual captured/live/receiver dependencies,
initialization/callback availability and complete expected manager/module recipes.

Allowed transforms: imports/exports/type relocation, explicit this typing, narrow
factory/capture scaffolding, original constructor composition and thin delegates.
No original body/default/initializer or constructor argument changes.

Automated:
- [ ] All predecessor hashes/root controls/public assertion bytes match.
- [ ] Complete15-body/constant/type/three-constructor and initialization recipes saved.
Manual: none under standing continuation authority.

## Phase 2: implement and qualify the full boundary

Implement all five owners, type consolidation and manager wiring. Add five direct
suites: completion-diagnostics.test.ts, completion-guards.test.ts,
completion-events.test.ts, completion-composition.test.ts and
completion-workflow.test.ts. A shared test-utils/completion-helpers.ts can build on
existing infrastructure mocks and actual migrated repositories. Existing public
assertions and the previously extracted owner modules are frozen.

Cover original phase/error/bounds/scan-cap/blocker/format behavior; termination and
pending-guidance error ordering; exact lifecycle/container identity and missing-pod
behavior; transition validation, memory/update/journal/publication/readiness order,
transaction commit/rollback event visibility and completion summary defaults. Use
actual repositories/afterCommit for durable effects, not just a stubbed call sequence.

Prove constructor inputs/returned functions preserve references and perform no
service calls. Exercise actual composed human/source/decision owners through the
new boundary: pending question/guidance holds, no-change completion, changed-source
validation and unchanged owner failures. Entry cases cover native Goal gate,
advanced-state early return, undefined source preparation, dynamic validation receiver,
artifact coalescing across pod/generation/cycle, rejection identity and matching-promise
cleanup. Dispose all deferred promises/timers and retain unrelated map entries.

At least three actual private-file SQLite close/reopen cases cover complete source
status/journal/events, held human work and failed/rolled-back transition or artifact
completion recovery. Check integrity/FK, unrelated row preservation and actual record
contents. Provider/container/worktree/launch calls are controlled; local private
filesystem operations are allowed. No live external execution is needed.

Run full unchanged1,192 public suite, five direct suites, supplemental new-test/fixture
semantics, scoped Biome/whitespace and daemon/dependency build/declarations. Supplemental
source diagnostics must match the qualified original baseline; do not silently repair
original-policy/types. Retain initial failures and fix only implementation scaffolding
or incorrect fixture assumptions, without weakening public assertions.

AST proof compares all15 complete bodies/parameters/defaults, the constant, phase
union and all three full constructor expressions/arguments. Compare complete manager,
five new modules and the type-only agent-contract recipe. Only manager and the explicit
agent-contract type relocation may change existing package/script bytes; all2,036
other predecessor files and six root controls remain frozen. Verify no inline completion,
transition/guard/reporting algorithm remains, no broad manager imports or new>=1,000-line
module, and the existing three completion owner files remain byte-identical.

Automated:
- [ ] All15 bodies, constant/type, three constructors and full file recipes preserved.
- [ ] Full1,192 public names/statuses/assertion bytes match and delegates pass.
- [ ] Five direct suites and three actual private-file SQLite reopen cases pass.
- [ ] Build/declarations, scoped lint/whitespace and test semantics pass; no new source diagnostic.
- [ ] Complete milestone25 algorithms/composition are domain-owned with original references.
Manual: none for this local compatibility extraction.

## Phase 3: frozen regression qualification and continuation

Run all169 inherited affected suites plus five new direct suites and any missing
completion/journal/nudge/deletion/termination/readiness/artifact/event repository
collaborators, deduplicated and unfiltered with SKIP_DB_TESTS=0. Record exact actual
paths/counts before execution. Retain inherited gates; no new product skips.

Freeze final package/script and root hashes; commit/push implementation checkpoint.
Run the same complete pinned pipeline:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Node22.23.3/pnpm9.15.4/SQLite3.49.2, executable task-local npx launcher, frozen install
without fallback/lock mutation, all uncached Turbo groups. Retain only the established
2 MiB root-lint processing limit and existing warnings, with no disabled rule/config/
dependency/selection changes. Record actual test delta/counts and match the same ten
full-suite gated skips. Recheck frozen hashes after pipeline.

Write .autopod-data/completion-orchestration/proof.json with tested revision, actual
commands/results, public/recipe/source evidence, durable cases, limits and remaining
scope. Commit/push qualification docs, verify clean local/remote identity, then update
roadmap/count only after proof. Continue26 (approval/readiness). The full goal stays
active through34, including27's explicit delivery/size review and final facade,
inventory, mutable-owner cleanup and uncached regression finish gates.

Automated:
- [ ] Full affected set passes with actual SQLite and no new skips.
- [ ] Full frozen uncached pipeline passes; actual counts/environment/gates documented.
- [ ] Final source hashes and clean pushed revision match tested implementation.
- [ ] Plan/roadmap mark25 only after proof and retain all26–34 finish gates.
Manual: none; live integration/production acceptance remains separately authorized.

## Compatibility and rollback

No migration, product behavior or stronger transaction/replay/termination guarantee.
Preserve public paths, union values, receiver semantics and exact callback timing.
Revert manager, type-only agent contract edit and all five new owners together for
rollback. Local proof does not claim provider/cloud/container acceptance. Final
manager<=1,500 lines and full327-unit/73-member/ownership reconciliation remain33/34.
