# Slice 26: complete approval and readiness

Status: IN PROGRESS — complete extraction implemented; frozen qualification pending.
Date:2026-10-19. Baseline:e25082d4bbf51e89d304c31309c38dd7cfdb106e.
Branch:codex/pod-manager-workspace.
Worktree:/Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Research:../research/2026-10-19-pod-manager-approval-readiness.md.

## Outcome and authority

Complete milestone26, including the entire794-line approveSession body, four other
public methods,12 helpers, snapshot exclusion array, readiness service construction
and three types. Manager starts at8,591 lines. Helpers alone do not complete this
milestone. Preserve public signatures/imports, actor/waiver/readiness policy, original
callback/await/error/default behavior, durable records and original shared resources.
The user authorized research→plan→implement→qualify across the remaining roadmap;
checkpoints record evidence without repetitive approval. Goal stays active through34.

No new state/schema/profile/credential/product/security policy, provider execution,
live Docker/Azure acceptance, integration, PR/main merge or deployment. Approval's
existing inline delivery remains preserved in this extraction; milestone27 must
review/extract that delivery along with validation trigger/revalidation delivery and
its temporary source-size exception. Remaining control/resource/recovery algorithms
retain their later roadmap owners and exact narrow callback references.

## Five domain source files

Create in packages/daemon/src/pods/:

1. approval-policy.ts: eight original static helpers actorLabel, legacyRespondedBy,
   buildValidationWaiver, parseValidationOverrideResponse, normalizeApprovalReason,
   readinessSkipReason, assertApprovalAllowed, taskSummaryWithApprovedFactWaiver;
   original APPROVAL_SNAPSHOT_EXCLUDES expression. Keep original imports, regexes,
   timestamp/actor defaults, fact/deviation merge and validation waiver semantics.
2. approval-readiness.ts: two constructors resolve original initialization order.
   createReadinessRefresh(live,captured) contains the original readinessService
   construction statement and refreshReadiness function. Its three original deps
   fields (actionAuditRepo/eventRepo/providerAttemptRepo) are read at construction,
   at the original service construction point. Return the same service and callback.
   createApprovalReadiness(captured) returns original resolveApprovalReadiness,
   persistReadinessApproval and assertApprovalCurrent functions. Capture the shared
   advisory map, original service, pod/event/guard/status references. The functions
   are unchanged and constructors invoke no services.
3. approval-workflow.ts: createApprovalWorkflow(captured) returns the complete
   approveSession function unchanged. No this/deps access exists in its body.
   Preserve all snapshot, durable publication/reconciliation, queue/rebase/review/
   merge/PR retry/fallback, fences, failure parking and cleanup branches. These are
   original approval lifetime algorithms;27 owns their subsequent delivery boundary
   review, not policy correction. Keep all original shared maps/queue/callbacks.
4. approval-controls.ts: createApprovalControls(captured) returns original
   approveAllValidated, approveFactWaiver, forceApprove and
   refreshReadinessAfterQualityScore bodies. Explicit ApprovalControlCalls this type
   contains only approveSession and revalidateSession. Thin facade delegates use
   .call(this,...) for those two receiver-dependent functions; retain their exact
   dynamic call arities/defaults. Other methods use direct delegates.
5. approval-contracts.ts: move the original ApproveSessionOptions,
   ApproveAllSkippedPod and ApprovalReadiness declarations, plus explicit observed
   captured/live/receiver input contracts. Public manager imports/re-exports the
   original two public type names without consumer changes. Use existing domain
   types or factory Parameters/ReturnType, never PodManager/PodManagerDependencies
   imports or derived broad bags. No API additions beyond internal exports.

Every new source module stays below1,000 lines. The approval body is794 lines;
imports/factory/type scaffolding must fit below the bound, with most types in
contracts. Review actual formatted size before qualification; no hidden monolith.
Existing readiness-review.ts, artifact snapshot, publication/merge ledgers and other
collaborator algorithms remain unchanged. No original body or initializer changes.

## Exact construction and facade behavior

At the original readinessService declaration (:1500), replace service/refresh
construction with createReadinessRefresh using the original captured inputs and live
object. This makes refreshReadiness available before completion-events (:2235 onward)
captures it. Preserve original construction-time dependency reads and same service.

Only after completion-events provides emitActivityStatus, compose
createApprovalReadiness. The original advisoryRuns map and all guard/service/event
references are then initialized. This split avoids a cycle between refresh callback
availability and advisory-wait status reporting. Preserve all original map/set/queue
instances; resource allocation stays assigned30/31. Constructors allocate functions
only and introduce no service call, timer or asynchronous boundary.

Compose main workflow and controls before the public object, after all original
captured functions exist. Replace the five public bodies with thin delegates while
retaining original signatures/defaults; receiver commands resolve on invocation's
this. Static policy imports serve all earlier existing users. Remove only imports
made unused by the extraction. No broad manager capture, extra async proxy promise,
new retry/approval policy or relocated resource initialization.

## Phase1: qualified baseline and complete recipes

Verify all2,049 qualified Slice25 package/script hashes and six root controls. Freeze
full1,192-case public assertion bytes and names/statuses; reuse its qualified report
only with explicit unchanged-source provenance. Save manager,17 bodies, all three
types, array initializer and readiness construction expression. Save actual symbol/
live/receiver references, construction points and complete expected file recipes.
Allowed transforms: import/export/type/factory scaffolding, explicit this typing,
original instance composition and thin delegates. Bodies/defaults/initializers stay.

Automated:
- [x] Qualified hashes/root controls/public bytes/provenance match.
- [x] Complete17-body/three-type/two-binding and source/constructor recipes saved.
Manual:none under standing continuation authority.

## Phase2: implement and prove the whole boundary

Implement five owners and manager wiring. Add approval-policy.test.ts,
approval-readiness.test.ts, approval-workflow.test.ts, approval-controls.test.ts and
approval-snapshots.test.ts. Shared test-utils/approval-helpers.ts may build on existing
mock infrastructure and actual migrated repositories; existing assertions stay frozen.

Cover static actor/waiver/override selection, reason/automation policy and exclusion
array; readiness service capture/refresh statuses, failed refresh, exact advisory
promise wait and series/pod scope; approval identity replacement/allowed cleanup,
guidance/decision/termination ordering; public callback references and constructor
availability. Exercise normal/no-change/blocked approval, snapshot success/failure and
source/resource retention through original controlled adapters. Existing full public
suite remains authority for all preserved merge/publication/recovery branches.

Controls cover bulk skips/errors and exact dynamic approval options, active versus
settled fact waivers, historical fact authority, pending guidance/unverified task
blocking, preserved unrelated summary facts, force-approved escalation/audit/waiver
and dependent effects. At least three real private-file SQLite close/reopen cases
prove approval/readiness state/history, fact waiver/force approval and blocked or
failed approval retaining original source/resources. Check integrity/FK and unrelated
rows. Private local filesystem/snapshot/Git evidence where practical; external
runtime/provider/container/worktree operations remain controlled, with no paid/live
execution. Release all promises/timers and private temporary resources.

Run full unchanged1,192 public suite, five new direct suites, supplemental new-test/
fixture semantics, scoped Biome/whitespace and daemon/dependency build/declarations.
Supplemental source diagnostics must match the original baseline; do not repair
unrelated original-policy/types. Retain initial failures and correct scaffolding or
incorrect fixtures without weakening public assertions.

AST audit compares17 complete bodies/parameters/defaults, three types, original
array/service initializer and entire readiness constructor arguments. Compare complete
manager/five-module recipes; all2,048 other predecessor package/script files and six
root controls remain frozen. Confirm no approval/readiness rules remain inline, no
broad manager imports and all new source files<1,000 lines. Preserve prior domain
owners and exact mutable-state references/construction sites.

Automated:
- [x] Complete bodies/types/initializers/constructor and full recipes preserved.
- [x] Full public1,192 names/statuses/assertion bytes match; thin delegates pass.
- [x] Five direct suites and three actual private-file SQLite reopen cases pass.
- [x] Build/declarations, lint/whitespace and test semantics pass; no new source diagnostic.
- [x] Complete26 boundary is domain-owned, retaining original references/initialization.
Manual:none for the bounded compatibility extraction.

## Phase3: frozen qualification and continuation

Run all180 inherited affected suites plus five new direct paths and any missing
readiness/waiver/quality/escalation/snapshot/publication/merge collaborators, deduplicated
and unfiltered with SKIP_DB_TESTS=0. Record actual command/paths/counts before execution.
Freeze final package/script/root hashes, commit/push implementation checkpoint, then:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Pinned Node22.23.3/pnpm9.15.4/SQLite3.49.2, executable local npx launcher, frozen install
without fallback/lock mutation, all uncached groups. Keep only inherited2 MiB root-
lint processing limit/existing warnings; no disabled rules or config/dependency/
selection changes. Match same ten full gated skips and record actual test delta/counts.
Recheck frozen bytes after pipeline. Write .autopod-data/approval-readiness/proof.json
with actual tested revision, claims/evidence/commands/results, durable cases and limits.
Commit/push qualification docs, verify clean local/remote identity, then mark26 in
plan/roadmap and continue27. Goal remains active through34;27 must cover delivery in
approval/validation paths and the trigger size review.33/34 retain facade<=1,500 lines,
full327-unit/73-member reconciliation, mutable-owner cleanup and final uncached proof.

Automated:
- [ ] Full affected set passes with real SQLite and no new skips.
- [ ] Full frozen uncached pipeline passes; actual environment/counts/gates recorded.
- [ ] Final frozen bytes match a clean pushed tested revision.
- [ ] Plan/roadmap mark26 only after proof, preserving27–34 finish gates.
Manual:none; integration/production acceptance remains separately authorized.

## Compatibility and rollback

No migration, public contract or policy change, or stronger transaction/replay/
termination guarantee. Revert manager and all five new owners together. Local proof
is bounded to controlled external infrastructure and actual local repositories/files.

## Implementation checkpoint

All17 complete body/parameter/default recipes, three types, both original binding
initializers and the readiness construction statement match the original AST. Six
full manager/module recipes match;2,048 other predecessor package/script files and
six root controls remain unchanged. Manager8,591 →7,399 lines. Five new owners are
135–835 lines; full approval lifetime is in scope. Service/refresh and later context
construction retain original dependency timing, shared maps/queue and callback identity.
Promise-returning public delegates return owner promises directly, retaining original
owner async bodies/defaults without redundant proxy promises.

The unchanged public suite passes all1,192 names/statuses/assertion bytes. Five new
direct suites pass25 cases, including four real private-file SQLite reopen cases for
confirmed publication/readiness/events, blocked approval retaining identity/resources,
historical fact waiver and force-approved escalation/waiver audit. Real private report
snapshot/receipt construction, advisory waiting, constructor dependency capture,
identity guards, automation/reason/waiver rules, actor defaults and dynamic control
calls are exercised. External provider/container/worktree/launch paths are controlled;
publication uses actual local ledger admission with synthetic transport receipts.
No live container/cloud/model acceptance is claimed.

Daemon/dependency build/declarations and scoped lint/whitespace pass. Six new test/
fixture files have zero semantic diagnostics. Six supplemental source diagnostics
match original baseline code/messages exactly (including the existing unexported
FactCheckResult type and nullable callback inputs); no new diagnostic. Those original
type/policy repairs remain outside scope. Initial audit-parser, type-import, snapshot
fixture-order and incomplete fixture-shape failures are retained. Corrections change
only scaffolding or fixture setup, not original bodies/public assertions.

Evidence:.autopod-data/approval-readiness/ including movement-final.log/movement.json,
baseline-type-comparison.json, public-comparison.json and named reports/exits;
direct JSON is packages/daemon/.autopod-data/approval-readiness/direct-final.json.
Expanded regression and full frozen qualification remain required before26 is done.
