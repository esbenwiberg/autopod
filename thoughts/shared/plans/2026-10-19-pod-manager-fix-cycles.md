# Slice 28: complete fix-cycle ownership

Status: IMPLEMENTED — expanded regression/frozen qualification in progress.
Date: 2026-10-19. Baseline: ae4af77283f0555bcbd19b6f5471e0c03c1282ac.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research: ../research/2026-10-19-pod-manager-fix-cycles.md.

## Outcome and authority

Complete milestone28 across fix task/feedback policy, provider binding, canonical
admission/recycling, validated fix delivery, parking and three public commands. Move
all12 inventoried function/method bodies, the full249-line canonical async arrow and
four other original bindings. Manager starts at6,916 lines. Preserve the entire
responsibility rather than complete a helper-only extraction. Same public signatures,
helper exports, status/error/text/credential policy, callbacks/awaits and shared state.

The user goal “the rest of the slices” and remaining-roadmap execution authority
cover research→plan→implement→qualify together, including commit/push checkpoints.
The previous goal turn made concrete progress:27 was implemented, fully qualified
and pushed;28 research is complete. No blocker. This plan is recorded before product
writes and does not require repetitive per-slice confirmation. Goal remains active
through all34 architecture/regression gates.

No schema/profile/state/API/product/security corrections, additional retries or new
publication/journal/termination semantics. No external comment messages, paid/live
providers, Docker/Azure acceptance, PR/main integration or deployment. Existing raw
fix pushBranch and distinct manual/request admission policies stay as-is. Branch
source resolution remains assigned31; its original callback is a narrow port. Controls
29, resources30, recovery/workspace31, admission32 and final33/34 remain required.

## Current source and decisions

Source references use packages/daemon/src/pods/pod-manager.ts at the baseline above.
Research includes complete bodies and actual captured/live reads, with no this use.
providerBindingForFixPod (:2012) reads deps.providerAttemptRepo on invocation;
maybeSpawnFixSession (:2084) reads deps.launchConfiguration/admitDerived on invocation.
Pass the same live object through explicit narrow field interfaces, never copy these
fields at construction or derive a domain port from PodManagerDependencies.

Canonical admission initializes before createDeliveryPolling (:2533), whose startup
resume runs before runtime/workspace constructors. The old canonical arrow closes
over the later const stopMergePolling without reading it during construction. Its
new factory therefore receives stopMergePolling: (podId) => stopMergePolling(podId).
This exact-one-argument, synchronous forwarding closure resolves the existing function
only when invoked; constructors perform no service calls. Keep startup resume at its
current site. No duplicate poller, merge queue or publication provider is allocated.

resolveBranchSource initializes before fix policy/admission and retains its original
series/PR-owner algorithm outside28. All required event/credential/provider/queue
bindings are ready; cleanup remains the original hoisted callback. Canonical
admission still enqueues before pod.created, parent attempt/fix-id update and activity.
Recycling still stops/cleans merge_pending resources before queued transition and
clears exactly the original runtime/summary/validation/escalation fields.

Public spawnFixSession requires merge_pending and PR/series identity; requestFixSession
admits other nonterminal roots and reports structured parent_terminal. Preserve that
difference, max-ceiling behavior, feedback queue consumption boundaries and reply
best-effort handling. Fix delivery never merges the parent PR. Parent terminal checks
at the original three sites remain; do not add or omit asynchronous boundaries.

## Eight domain source modules

Create under packages/daemon/src/pods/:

1. fix-policy.ts: original buildPrFixTask, buildActionableFailureSummary and
   formatReviewFeedbackReply bodies, plus original REVIEW_FEEDBACK_REPLY_MAX_CHARS
   and FIX_DELIVERY_FAILED_PREFIX primitive initializers. Export the functions and
   needed constants. createFixCyclePolicy contains the original isFixCycleTerminal
   and isFixPodRecyclable arrow bindings and returns those exact per-instance
   functions, constructed at the old predicate site. Moving the two primitive
   constants to module scope changes no mutable resource or observable initializer.
   Retain text, PI/PII processing, ancestor/series selection and2000-character bound.
2. fix-provider-binding.ts: createFixProviderBinding(deps: FixProviderLiveDependencies)
   returns original providerBindingForFixPod. Its live interface exposes only the
   optional provider-attempt list port; retain account/runtime/model matching and
   method receiver. Construct before canonical admission at the old helper section.
3. fix-parking.ts: createFixParking(captured: FixParkingCaptured) returns original
   parkFixPodDeliveryFailure, isParkedHostPushRecovery and
   isRetryableFixDeliveryFailure functions. Keep per-manager function construction,
   credential-class forwarding to27, operator-retry prefix and original predicates.
4. fix-feedback.ts: createFixFeedback(captured: FixFeedbackCaptured) returns original
   postFixPodReviewFeedbackReplies. It imports the original formatter from policy;
   preserve filtering/host provider selection, activity/error counts and best effort.
   Constructor sends nothing; all tests use controlled adapters.
5. fix-admission.ts: createFixAdmission(deps: FixAdmissionLiveDependencies,
   captured: FixAdmissionCaptured) contains the complete unchanged canonical
   maybeSpawnFixSession binding and returns that exact arrow. Preserve root/terminal/
   active/operator-recovery/cap gates, one canonical row, native/legacy derived
   admission, id-collision loop, snapshot/options/series inheritance and effect order.
   Explicit live interface exposes only optional launchConfiguration.admitDerived,
   using DerivedLaunchInput/EffectiveLaunchConfig domain types.
6. fix-delivery.ts: createFixDelivery(captured: FixDeliveryCaptured) returns unchanged
   completeFixPodAfterPush, sharing the original mergeQueue, PR factory and callbacks.
   Keep parent checks before/inside queue/after rebase, force push and explicit
   credentials, conflict/no-push completion, parked errors, replies only after push,
   cleanup and completion event. No new journal/publication path or mergePr call.
7. fix-controls.ts: createFixControls(captured: FixControlsCaptured) returns original
   extendPrAttempts, spawnFixSession and requestFixSession. The facade preserves each
   signature and returns the corresponding owner promise directly. No dynamic this
   adapter is needed; current bodies contain no this reads.
8. fix-contracts.ts: explicit observed captured/live interfaces for the factories,
   based on existing infrastructure/domain types, Pick/Parameters/ReturnType where
   appropriate. No any, public PodManager/PodManagerDependencies import or broad
   manager bag. Cross-owner function ports retain exact arities and return types.

Only pod-manager.ts changes among predecessor package/script source. Preserve both
existing public buildPrFixTask/buildActionableFailureSummary exports with imports/
re-exports from fix-policy.ts, so current tests/consumers keep their import paths.
Manager imports original static policy helpers and composes new owners with explicit
field lists. Remove only imports made unused by extraction. Do not edit existing
collaborator implementations or test assertions. Every new source module<1,000 lines.

## Construction sequence

At old isFixCycleTerminal binding, construct predicate factory and provider/parking
owners once, after branch-source/events/credentials references are initialized.
Compose canonical admission at the old maybeSpawnFixSession binding with the narrow
lazy stop callback. Compose feedback and delivery at their former helper section,
with all original captured references already ready. Polling captures the resulting
canonical admission and starts at its old site. Before the public return object,
compose controls after startMergePolling is initialized. Other validation/completion/
continuation/provisioning consumers keep their original callback references and
function signatures. New constructors bind functions only; no service call/timer or
extra async proxy is introduced. Same shared queue/provider/feedback repositories.

## Phase1: freeze qualified baseline and recipes

Verify all2,081 qualified27 package/script hashes and six root controls. Save complete
manager,12 full function/method bodies, allfive bindings, actual references/live reads,
constructor/startup sites and full expected source recipes. Freeze public test bytes
and reuse its qualified1,192-case report only after explicit matching-source provenance.
Allowed transforms are imports/exports/type/factory scaffolding, explicit exact-arity
lazy stop forwarding, thin public delegates and the documented primitive placement.
All complete bodies/defaults/arrow initializers stay identical after parsed formatting.

Automated:
- [x] Qualified predecessor hashes/root controls and public bytes/provenance match.
- [x] All body/binding/reference/construction and whole source recipes saved before edits.
Manual:none under standing continuation authority.

## Phase2: implement complete boundary and direct tests

Implement eight owners and manager wiring. Add co-located fix-policy.test.ts,
fix-provider-binding.test.ts, fix-parking.test.ts, fix-feedback.test.ts,
fix-admission.test.ts, fix-delivery.test.ts and fix-controls.test.ts, with shared
native repository/mocked infrastructure in test-utils/fix-cycle-helpers.ts. Reuse
existing test-utils factories without changing predecessor helpers/assertions.
Release fake timers, deferred waits and private temporary files.

Cover original task/series/ancestor/PII policy, reply outcomes/length, per-instance
predicates and prefix classification. Provider binding tests mutate the live repo
field after factory construction and distinguish runtime/model/account mismatch.
Parking tests distinguish credential forwarding from retained operator retry.
Feedback tests cover empty/support/filter/reply outcomes, thrown adapter and error/
resolution counts; no real comment API is invoked.

Admission tests cover root/subfix/terminal gates, active/operator-parked canonical
fix suppression, retry ceiling, native legacy insert, complete/failed/merge_pending
recycling and exactly ordered stop/cleanup/reset/enqueue. Verify original branch/base/
PR owner callback, provider snapshots, queue retention and live immutable-derived
admission wiring, including unavailable service. Public helper import paths and startup
with the lazy stop callback remain covered by the unchanged full public suite.

Delivery tests use the actual shared MergeQueue, controlled rebase/push adapters and
native linked rows. Cover terminal parent before queue, while waiting, after rebase;
rebase conflict without push; fresh explicit credentials/force target; parking with
resource retention; replies after push; original completion/events, no parent merge.
Controls cover distinct admissions, cap extension/reuse behavior, normalized/default
manual messages, request queue metadata/structured terminal result, exact canonical
callback arities and error identity/async effects.

At least three actual private-file SQLite close/reopen cases prove canonical
admission/parent+fix linkage/provider/feedback, recycle resets/iteration/attempts and
completed or parked fix delivery retaining resources/history; check integrity/FK and
unrelated rows. Immutable fix linkage must be set on insert, never by altering the
existing prepare task's membership. Frozen derived-config evidence uses native local
admission where practical and controlled uncharged infrastructure; do not claim live
provider execution from synthetic receipts.

Run unchanged1,192 public cases, all seven new suites and immediate predecessor direct
delivery/approval suites. Build daemon/dependencies/declarations, scoped Biome and
whitespace. Supplement new test/fixture semantics (zero diagnostics); compare moved
source diagnostics against the complete original manager baseline, no new diagnostic.
Retain initial failures and correct scaffolding/fixture setup without weakening public
assertions or correcting original out-of-scope policy/types.

AST audit compares12 complete bodies/parameters/defaults, canonical arrow and four
other binding initializers, public exports, startup/construction and complete manager/
eight-module recipes. All2,080 other predecessor package/script files and six root
controls remain frozen. Same73 public members, three thin delegates, all fix algorithms
in domain owners, every new owner<1,000 lines. No unowned callback algorithm or newly
allocated state is hidden in the facade.

Automated:
- [x] Whole bodies/parameters/bindings/exports/startup and full recipes match.
- [x] Unchanged public1,192 names/statuses/assertion bytes pass; same73 interface.
- [x] Seven new direct suites and three real SQLite reopen cases pass.
- [x] Build/lint/whitespace and new-test semantics pass; no new moved-source diagnostic.
- [x] Complete fix-cycle boundary is domain-owned with original shared state.
Manual:none for bounded local compatibility; no live external acceptance claimed.

## Phase3: frozen qualification and continuation

Run all216 inherited affected suites plus new paths/missing immediate fix/feedback/
configuration collaborators, deduplicated/unfiltered with SKIP_DB_TESTS=0. Save exact
paths/command before execution. Freeze final package/script/root hashes, commit/push
implementation, then run:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Pinned Node22.23.3/pnpm9.15.4/SQLite3.49.2, executable local npx launcher; frozen install
without fallback/lock change, all Turbo tasks uncached. Keep only inherited task-local
2MiB lint processing allowance/82warnings, no rule/config/dependency/selection changes.
Record actual deltas from27's8,835 passing Vitest/547 passing files/35Node tests with
the same ten inherited gated cases and no new skips. Recheck all frozen bytes.

Use prove-work after implementation, recording .autopod-data/fix-cycles/proof.json
with actual revision/commands/claims/evidence, all bodies/resources and limitations.
Commit/push qualification docs; verify clean local/remote identity. Mark28 only after
every gate passes and record29 operator lifecycle-control research. Full goal remains
active through34, including facade<=1,500 lines,327-unit/73-member/mutable-owner and
cleanup reconciliation, full frozen uncached pipeline and clean pushed final revision.

Automated:
- [ ] Full affected set passes with actual SQLite and no new skip.
- [ ] Full frozen uncached pipeline passes with actual counts/environment recorded.
- [ ] Frozen bytes/clean pushed revision verified and proof recorded.
- [ ] Plan/roadmap mark28 after qualification and next29 research is recorded.
Manual:none; production/integration work remains separately scoped.

## Compatibility, cost and rollback

No migration or public contract/policy change. Same queue/adapter operations, credentials,
async body/await order, admission snapshots and cleanup/event behavior. New factories
allocate closures only, preserving original per-manager predicates/parking callbacks;
two primitive constants move to policy module scope. The lazy stop forwarding callback
exists only to retain construction timing, has one string argument and no async proxy.
Revert manager plus eight owners together. Local proof establishes native repository/
queue behavior with controlled external adapters, not external delivery or stronger
atomicity/isolation/termination guarantees. No unresolved design questions remain.

## Implementation checkpoint — 2026-10-19

All12 original complete function/method bodies/parameters/defaults, canonical async
arrow and four other binding initializers match the original parsed source. Allnine
full manager/module recipes match; both public helper exports, all73 public members
and original polling construction arguments/startup call remain. The exact-one-argument
lazy stop callback preserves construction timing without an async proxy. Two live
fields remain live; all2,080 other predecessor package/script files and six root
controls are unchanged. Manager6,916→6,157 lines. Eight new owners are27–276 lines.

The unchanged1,192 public names/statuses/assertion bytes match and pass. Seven new
fix suites plus fourteen inherited delivery/approval suites pass97 cases (30new,
67inherited). Five real private-file SQLite close/reopen cases cover canonical
linkage/provider/feedback, recycling resets/iteration/attempts, frozen native derived
configuration despite preset edits, completed fix/history, and operator parking.
Shared native MergeQueue, terminal-parent races, no parent merge, response filtering/
bounds, credential identity, live provider/admission fields and control contracts
are directly exercised. Alleight new test/fixture files have zero semantic diagnostics;
all25 current source diagnostics match the original25-diagnostic manager baseline.
Build/declarations, scoped lint and whitespace pass.

Native derived admission uses actual configuration/snapshot admission and controlled
discovery, with a matching legacy profile/repository alias. Current canonical fix
insert still relies on legacy dispatch lookup when no explicit repository is passed.
The new negative case proves the existing missing-alias TypeError rolls back the
child/snapshot and leaves parent attempts/fix pointer/queue unchanged. It is preserved
compatibility behavior, not a newly introduced error or a claim of successful
alias-free native fix admission. Original body/initializer and unchanged collaborator
proof delimit this limitation; correcting that policy is outside this rewrite.

Initial audit/CommonJS naming and fixture failures are retained: actual task-summary/
output fields, optional provider support, legal escalation state, native profile
reference construction/typing, native repository dispatch binding and immutable
selected reuse profile. Fixes adjust scaffolding/fixtures only, without weakening
original public assertions or changing original source algorithms. All source/test
bytes are frozen before expanded/full qualification. Evidence is in
.autopod-data/fix-cycles/: extraction-recipe.json, movement.json, named reports/exits,
public-comparison.json, baseline-type-comparison.json and frozen-manifest.json.
Full affected/full uncached qualification, proof, clean pushed revision and29 research
remain required before28 is complete.
