# Slice 20: validation workflows

Status: IN PROGRESS — Phases 1 and 2 complete; full qualification next.
Baseline: 5c20dde639cd5c7297bc861952cb6a3ab87fb820.
Date: 2026-10-18. Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Scope and execution authority

The latest user goal is “the rest of the slices”. Continue the bounded roadmap
through Slice 34, preserving reviewable research/plan/implementation/qualification
checkpoints. This later instruction authorizes the remaining sequence together;
per-slice checkpoints record progress instead of requiring repetitive confirmations.
Keep the existing characterize → extract → qualify structure. Decisions changing
product behavior, APIs, credentials, persistence policy, PR/main integration or
production deployment remain outside this compatibility rewrite.

The full goal remains slices 20–34 and all final architectural criteria. Completing
this slice alone does not complete the goal. No delegation is required.

## Current state

The manager has 16,369 lines. triggerValidation is 1,103 lines and revalidateSession
555 lines. Both still orchestrate existing validation components, reviewer councils,
publication, PR delivery, advisory QA and completion/correction. Five validation
control methods remain: extendAttempts, applyOverridesInstant, interruptValidation,
updateFromBase and setSkipValidation. Abort controllers, extension-run coalescing and
update-from-base intents are manager-local mutable collections. Pure validation
policy/formatting/skill helpers and claim/skip/abort-rebase helpers remain local.

## Desired boundary

Move both complete workflow methods, the five complete control methods and all
Slice-20 helpers into explicit internal modules. Public methods become delegates.
Retain original bodies, awaits, effect ordering, guards, errors and live/captured
collaborator semantics. No new asynchronous stage boundary or extra await inside
these algorithms: completion and ownership checks must retain their current timing.

New product files:
- pods/validation-workflow-policy.ts: summarizeValidationPhases, failedValidationPhases,
  failedFactIds, hasPendingFactDecision, loadCodeReviewSkill, getPodValidationSuite,
  isPodValidationDisabled, getPodValidationSkipPhases, protectedOperationalPathReason,
  podExplicitlyScopesOperationalPaths, assertProtectedOperationalPathsInScope,
  makeUnexpectedValidationFailureResult. Existing manager users import these helpers.
- pods/validation-workflow-state.ts: construct the same three collections once per
  manager; return the original typed map/set references to their existing consumers.
- pods/validation-workflow-controls.ts: five complete public control algorithms plus
  runUpdateFromBaseAfterAbort, applySkipValidationDecision and claimValidation.
- pods/validation-trigger-workflow.ts: complete original triggerValidation algorithm.
- pods/validation-revalidation-workflow.ts: complete original revalidateSession algorithm.
- pods/validation-workflow-ports.ts: explicit infrastructure and cross-workflow types,
  selected captured dependencies, narrow live launch/pending-override view, typed
  method receiver ports. No import of PodManager or PodManagerDependencies.

Only existing product file changed: pods/pod-manager.ts (imports, composition,
definition removal, thin delegates, strictly unused import cleanup).
Tests: append public compatibility in pod-manager.test.ts; new policy/state and
control contract tests. Use existing migrated local SQLite repositories. Evidence
and scripts stay ignored under .autopod-data/validation-workflows/.

## Responsibility and size review

The initial trigger owner intentionally exceeds 1,000 lines: its complete 1,103-line
algorithm includes the independent-council decision chain and inline PR delivery.
Keeping the function whole avoids introducing an await between ownership checks and
effects. This is a bounded, explicit intermediate exception, not a replacement for
the 16,369-line manager. Slice 27 must move the inline delivery policy from both
validation owners when it establishes delivery ownership, and recheck the size.
Track this debt in the remaining roadmap. Other new owners stay below 1,000 lines.
Do not silently split into async stages that change concurrent-decision windows.

## Collaborator and receiver semantics

Derive each captured view from identifiers actually used by that owner. Capture
original manager-local references once. Reuse typed existing infrastructure and
existing extracted-component return types; retain repository types required by
existing atomic escalation helpers. The common contract describes only validation
collaborators; owners select their own Pick, never a broad public-manager bag.

Pass original deps through a narrow live view for launchConfiguration read/goals.get
and pendingOverrideRepo.flush. Preserve late optional property and method lookup
across awaits; do not clone, bind or pre-read them.

Methods keep their original this calls against explicit small receiver interfaces.
Manager delegates create lazy forwarding ports for just those methods, preserving
late lookup and original manager receiver when invoked, including setImmediate work.
The full manager object is not passed as an owner dependency. Delegates return the
owner promise directly without becoming new async wrappers or adding awaits.
Construction is inert. Compose controls where the old abort-rebase helper stood,
after state creation; compose workflow owners after all existing captured component
bindings and before returning the public object. Earlier methods/functions retain
safe initialization and existing collection identity.

## Phase 1: characterize unchanged product

Append validation workflow compatibility. Exercise late public approve dispatch
through both workflows, duplicate extension coalescing and later admission, and
update-from-base deferred follow-up using a replaced public method. Use controlled
engine/worktree promises, actual manager repositories and existing fixtures.

Run the entire manager suite on unchanged product bytes, not a name-filter subset.
Freeze its full assertions and selected names/statuses before movement. Supplemental
semantic diagnostics cover the appended group. Preserve prior assertions byte for
byte; add no skips. Record actual counts, commands, runtime and baseline hashes.

Automated:
- [x] Full manager baseline passes with SQLite and unchanged product bytes.
- [x] New characterization types pass; assertions/names/source hashes frozen.
Manual: none; remaining sequence is user-authorized together.

## Phase 2: extract complete owners

Move the complete seven public algorithms and fifteen helper declarations without
rewriting their bodies. Move three collection constructors into their state factory;
retain shared reference identity for kill/watchdog/delete and validation consumers.
Only change declaration/export/factory scaffolding and public receiver forwarding.
Use parsed TypeScript and original source to verify each full body, complete expected
manager/module recipe, retained imports and constructor/composition order. Record
and review every permitted syntactic change. Remove only genuinely unused imports.

New direct tests cover policy/status/fact/operational-path/skill behavior, isolated
state instances/shared collections, validation claim replacement/decisions/termination,
abort handling, cached override evaluation, skip decision/waiver and coalesced recovery.
Use real local repository state for control transitions and a private file SQLite
close/reopen case for retained waiver and pending overrides where persistence is
asserted. Owner infrastructure and native Goal/provider/container execution remain
controlled; public tests retain full workflow integration coverage.

Automated:
- [x] Frozen full manager suite passes with identical names/statuses/assertions.
- [x] Direct owner/policy/state/local repository tests pass with no new skips.
- [x] Exact moved bodies, full recipe and source scope pass.
- [x] Scoped Biome/whitespace, supported declaration build and supplemental new-test
  semantic checks pass.
Manual: none.

## Phase 3: qualification

Use Node22.23.3/pnpm9.15.4, SQLite3.49.2, SKIP_DB_TESTS=0 through the established
npx launcher. Run all inherited 95 affected suites plus new Slice-20 suite paths,
unfiltered and deduplicated. Record the exact resolved command and actual counts.
Then freeze source and run:

    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Frozen install must succeed without fallback/lock mutation. Retain only the established
2 MiB root lint processing limit and process-only maintenance.auto=false. No rules,
selection, dependency or repository/global config changes. Preserve and investigate
failures before unchanged reruns. Compare all package/script and six root control
hashes before/after qualification. Commit/push checkpoints and final clean identity.

Automated:
- [ ] Complete affected set passes with SQLite and no new skips.
- [ ] Full uncached pipeline passes; actual counts and existing skips recorded.
- [ ] Frozen source, exact movement and pushed clean revision verified.
- [ ] Plan and roadmap record completion and the next incomplete milestone.
Manual: none. No live infrastructure, PR/main merge or deployment acceptance claim.

## Compatibility, performance and rollback

Preserve state machine, retry/admission/coalescing, worker and validation provenance,
waivers, pending decisions, independent review ledger, credential recovery, event and
usage/history timing, advisory publication and resource ownership. Native Goal guards
and immutable snapshots retain their current behavior. This extraction promises no
faster execution or stronger isolation/atomicity/authorization/replay guarantee.
No migration. Revert the manager composition and these owners together to roll back.

References: remaining-roadmap.md (Slice 20 and final gates); current manager functions
listed above; existing validation components and completed Slice 19 qualification.

## Phase 1 evidence

The full unchanged-product manager suite passes: 1192 tests, no failures/skips.
Four new public cases cover late approval lookup in both flows, extension coalescing
and later current-method admission, and deferred clean-rebase dispatch. The appended
fixture's missing Pod type reference was replaced by its exact three-status input
union; this changed no runtime/assertion code. Supplemental diagnostics are zero.
The entire public assertion bytes and names/statuses are frozen before extraction.
All other baseline source/control hashes match.

## Phase 2 evidence

All 22 original algorithm/helper bodies and parameters match parsed TypeScript after
scaffolding/export/receiver-type changes and formatting. The complete manager/module
recipes match, with type-union layout, optional type-member terminators and attached
JSDoc indentation normalized. Runtime statement tokens are compared strictly. All
1,981 other baseline package/script hashes and six root controls match. The manager
is 14,371 lines (1,998 fewer). New owners are policy 190, state 6, controls 412,
contracts 224, revalidation 682 and trigger 1,273 lines. The trigger-size exception
remains explicitly assigned to delivery extraction/size review in Slice 27.

All 1,192 full manager cases pass before/after with frozen assertions/names/statuses.
All 34 direct policy/state/control cases pass, including two private migrated file
SQLite cases preserving a resolved human waiver and flushed queued overrides through
integrity/FK-checked close/reopen. All 97 affected suites pass: 3,406 cases, no skips.
The final scoped lint, build/declarations, whitespace and all three supplemental test
boundaries pass. Node22.23.3 opens SQLite3.49.2; pnpm9.15.4.

The initial forwarding scaffold passed an explicit undefined for omitted options;
the frozen full suite caught three argument-arity failures. Eight forwarding ports
now forward rest tuples exactly and retain late receiver lookup. Algorithm bodies
and frozen public assertions were never changed. Initial direct fixtures needed
complete reviewer fields/actor variants and a derived public fact type; explicit
suite precedence was corrected in the test expectation and the absent-suite case
was added. Initial diagnostics and recipe-audit formatting diagnostics are retained.
No original policy/algorithm correction or new await boundary was introduced.

Next: full uncached pipeline on final frozen 1,991 package/script hashes and six
root controls, then record completion and continue Slice 21 under the full user goal.
