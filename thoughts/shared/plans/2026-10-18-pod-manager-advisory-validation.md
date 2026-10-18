# Slice 19: advisory validation execution and publication

Status: PLANNED — awaits explicit approval; no implementation tests have run.
Date: 2026-10-18. Baseline: ecc324ca4a403d49397dd63cecb1a881e653ad06.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Move the complete advisoryPublicationOwnership and runAdvisoryAfterValidation
functions into a small internal owner, advisory-validation.ts. Keep blocking
validation/PR progression, advisory scheduling, historical evidence and current
lifecycle publication behavior intact. This is milestone 19 of the finite 19–34
remaining roadmap. Once complete, 15 numbered milestones remain.

Use the established characterize → extract → qualify structure. One approval covers
all three phases together, with no intermediate manual gate for this headless
compatibility extraction. Commit/push verified increments per repository instructions.
Planning changes documentation only. Implementation requires explicit plan approval.

Research: ../research/2026-10-18-pod-manager-advisory-validation.md.
Roadmap: 2026-10-18-pod-manager-remaining-roadmap.md.

## Current state and desired end state

pod-manager.ts has 16,521 lines. The two complete functions occupy :5363–5391 (29
lines) and :5393–5529 (137 lines): 166 function lines, excluding the blank separator.
Two awaited runner calls (:13376/:14024) and two caller ownership checks
(:13383/:14031) remain unchanged, as does the runner's internal ownership capture.
The callers are triggerValidation and revalidateSession. Approval reads the same
advisoryRuns map at :3181; deferred cleanup reads it at :3840.

The new createAdvisoryValidation factory returns those two original functions. The
manager composes it at their original definition site, after validation-progress
composition (:5018), and before parkOnCredentialFailure. Construction calls no
collaborator. Keep the same map, acquire/release functions and reference semantics;
no second registry or semaphore. Earlier readiness callbacks refer to the existing
map, and the registry remains available to approval/cleanup without initialization
reordering. Slot/run-state ownership moves later in milestone 30.

Exactly two product files may change:
- packages/daemon/src/pods/pod-manager.ts: add import/composition and remove the two
  complete definitions; remove only imports proven unused by that move, if any.
- New packages/daemon/src/pods/advisory-validation.ts.

Exactly two test files may change:
- packages/daemon/src/pods/pod-manager.test.ts: append public characterization.
- New packages/daemon/src/pods/advisory-validation.test.ts: direct and real local
  repository/reopen contracts.

## Implementation approach and dependency contract

Declare a narrow local interface; never import PodManager/PodManagerDependencies.
Capture these exact twelve existing collaborators once under their existing names:

    podRepo: Pick<PodRepository, 'getOrThrow' | 'update' | 'hasUnansweredDecision'>;
    nudgeRepo: Pick<NudgeRepository, 'hasPending'>;
    validationRepo?: Pick<ValidationRepository, 'isLatestForPod' | 'updateAdvisoryResult'>;
    validationEngine: Pick<ValidationEngine, 'runAdvisoryBrowserQa'>;
    logger: Pick<Logger, 'warn'>;
    advisoryRuns: Pick<Map<string, Promise<ValidationResult>>, 'get' | 'set' | 'delete'>;
    acquireAdvisoryQaSlot(): Promise<void>;
    releaseAdvisoryQaSlot(): void;
    buildPhaseEventCallbacks: ReturnType<typeof createValidationProgress>['buildPhaseEventCallbacks'];
    ownedValidationCallbacks: ReturnType<typeof createValidationProgress>['ownedValidationCallbacks'];
    refreshReadiness(podId: string, options?: { advisoryQaInFlight?: boolean }): boolean;
    emitActivityStatus(podId: string, message: string): void;

Logger is the existing pino Logger type. Use type imports for repositories, engine,
progress and shared Pod/ValidationResult; import the existing captureValidationOwnership
implementation. Do not export new shared/public API. Preserve method lookup on captured
collaborator objects, including the optional engine method's presence check before
slot acquisition and lookup after the await. Do not cache/bind method properties or
normalize optional services. Factory replacement of its dependency object must not
change captured references. Preserve returns/signatures exactly:

    advisoryPublicationOwnership(expectedPod: Pod, blockingResult: ValidationResult,
      validationId: string | undefined, ownsInvocation: () => boolean = () => true)
      : ReturnType<typeof captureValidationOwnership>;
    runAdvisoryAfterValidation(podId: string,
      validationConfig: Parameters<ValidationEngine['validate']>[0],
      blockingResult: ValidationResult, validationId: string | undefined,
      expectedPod: Pod): Promise<ValidationResult>;

Move both COMPLETE function bodies unchanged, including comments, casts, awaits,
conditional spreads, historical writes, catches/finally and reference comparisons.
Verify the parsed TypeScript against a full explicit manager/module recipe, the
original bodies, both awaited external runner calls and both external ownership
checks. No receiver substitution, clone, new fence, catch, cancellation or policy fix.

## Compatibility requirements

1. Ownership uses status validated and the original lifecycle/execution/config identity
   captured by captureValidationOwnership. Pending nudge or unanswered decision blocks
   publication. Preserve the optional hasUnansweredDecision fallback to pendingEscalation,
   nullish versus false behavior, latest-history-id gate, attempt check, optional repo/id
   bypass and caught lookup errors. The invocation predicate remains map-identity based.
2. An absent advisory method returns the SAME blocking result without ownership capture,
   registry entry, slot work, callbacks or persistence. Construction is inert. With an
   engine method, initial ownership is checked before progress, acquisition or registry
   registration. Keep registered=false short-circuit: the closure must not read the
   uninitialized run binding. The map stores the inner run promise, which is not the
   outer async function's returned promise.
3. Emit waiting progress before acquisition. After acquiring, recheck ownership before
   callbacks/engine launch. Release exactly once in the inner finally on success,
   engine/callback failure or supersession; acquisition rejection does not release an
   unacquired slot. Pass exact config/blocking references, undefined signal and owned
   phase/review callbacks. Keep live engine lookup after the wait and original receiver.
4. The advisory phase-completed callback first attaches history, then (only if current)
   merges into the latest live result and refreshes readiness, then notifies subscribers.
   Preserve duplicate history/readiness work if both callback and final return report
   advisory evidence. Do not turn this into one atomic transaction or deduplicate it.
   Other completed phases keep current callback forwarding without advisory merging.
5. A falsey advisory result returns the original blocking result after the current
   check. A current execution failure logs the same warning/activity and returns the
   blocking result; a superseded failure propagates the existing stale-execution error.
   Publication/final persistence exceptions retain existing propagation and earlier
   effects. Do not broadly swallow errors or roll back prior writes.
6. On final advisory return, accumulate known token usage before the final ownership
   check, including on a superseded lifecycle of the same immutable pod/task. Preserve
   other phase usage, additive advisory inputs/outputs and optional cached/cost keys
   only when totals are positive. Update exact history before the final ownership
   check. Superseded evidence/spend can be retained, while live replacement state,
   readiness/events and container release remain protected by existing caller fences.
7. Final merge uses the original read-current timing and live result fallback. Keep
   overall blocking status and other evidence. Finally delete the registry entry only
   when it still equals this run, including error paths; never remove a replacement run.
   Approval and deferred cleanup must still see the same promise and slot queue.
8. Callers retain PR creation before advisory settles, a single blocking validation
   completion event, both post-await ownership fences, subsequent container stopping,
   fix-pod handling, auto-approval and return shapes. The semaphore stays at one; no
   change to cancellation, fairness, concurrency limit or actual browser runner policy.

## Non-goals

Do not move triggerValidation/revalidateSession, refreshReadiness/approval, map/semaphore,
cleanupContainerAfterAdvisorySettles, actual browser QA engine or validation history
implementation. Do not change public API, profiles, state machine, schema, dependency,
credential policy or blocking outcomes. No live paid reviewer/browser/container/provider
run, PR/main integration or deployment is authorized by this extraction.

## Phase 1: characterize actual public callers

Only edit pod-manager.test.ts. Append `advisory validation compatibility`, using the
existing migrated manager fixtures and controlled engine/container interfaces. Exercise
both triggerValidation and revalidateSession. Close gaps without importing the future
module or exposing private manager internals.

Cover absent engine method; current QA success/null/rejection; ownership loss after
launch and while queued (generation/container/status/attempt/new history/decision);
retained old-history evidence and cumulative spend; same-manager two-pod single-slot
scheduling; subscriber observation after callback merging; approval waiting and deferred
resource cleanup without replacement release. Existing cases already cover several
of these; reuse them as regression evidence rather than mirror every direct test.
Add public checks only for actual gaps. Close fixtures and settle controlled promises.

Freeze the appended public bytes and exact selected filter before movement:

    advisory validation compatibility|advisory|Advisory

This deliberately selects all existing advisory-named cases as well as the new group.
Record actual selected names/count/statuses; no guessed pass count. Compare before/after
identically. Filter-excluded cases are not newly skipped; final affected run is unfiltered.

### Success criteria

Automated:
- [ ] New and selected existing public checks pass with unchanged product bytes.
- [ ] Selection/filter and characterization bytes are frozen; no new test skips.
- [ ] SQLite loads under the pinned runtime; appended test group has no semantic errors.

Manual: None required; one approval covers all three phases together.

## Phase 2: extract and verify the owner

Add the factory/module and compose at the original site with the twelve collaborators.
Move both whole functions unchanged. Add direct tests for requirements 1–7, controlling
slots/promises and observing call order, arguments, references and retained effects.

Direct matrix includes inert construction/captured services; absent method; initial
stale rejection; nullish fallback versus explicit false unanswered-decision support;
all ownership identities plus attempt/history/invocation/decision gates; queued stale
release/no engine launch; acquisition rejection; success/null/engine and callback
failure; exact config/result/signal/callback forwarding; progress suppression; callback
merge-before-event; callback plus final duplicate writes; history failure and usage
failure timing; positive/zero cached/cost key shape and prior phase usage; old run
settling after a replacement registry entry; live engine method replacement/removal
across slot wait with original receiver. Keep fixtures minimal and typed.

At least three private migrated file SQLite integration cases use actual pod, nudge,
validation repositories and real captureValidationOwnership/progress/event wiring:
current callback/final result and usage; superseded attempt/history retaining old evidence
and spend without overwriting latest result; pending human decision superseding publication.
Include real readiness service through a narrow adapter where its result is asserted.
Close/reopen and verify exact validation row, pod usage/live result, event persistence,
unchanged blocking/waiver evidence, integrity_check and foreign_key_check. Engine and
container execution stay controlled. Do not claim browser acceptance or crash replay.

Verify exact movement/recipe and both pairs of external calls. Re-run frozen public
selection, direct suite, scoped Biome/whitespace and supplemental semantic diagnostics
for both new test boundaries. All other baseline package/script paths and six root
controls must match. No behavior correction after movement.

### Success criteria

Automated:
- [ ] Original bodies/call sites and full manager/module recipe match parsed TypeScript.
- [ ] Frozen public checks have identical assertions and selected names/statuses.
- [ ] Direct and real local repository/reopen contracts pass with no new skips.
- [ ] Exactly two product/two test paths change; other source/control hashes match.
- [ ] Scoped Biome/whitespace and supplemental test semantic checks pass.

Manual: None required; no live infrastructure acceptance claim.

## Phase 3: qualify frozen source and complete the plan

Record actual Node/pnpm and SQLite runtime, commands/exits, raw logs and a complete
source manifest in ignored .autopod-data/advisory-validation/. Reuse the established
Node22.23.3/pnpm9.15.4 task-local launcher and SQLite3.49.2 qualification environment.
The original dependencies still use npx pnpm, never global pnpm.

    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'advisory validation compatibility|advisory|Advisory'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/advisory-validation.test.ts
    npx pnpm exec biome check --files-max-size=2097152 packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/advisory-validation.ts packages/daemon/src/pods/advisory-validation.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Use all predecessor 92 affected suites plus THREE verified-distinct paths, unfiltered
(95 suites total):
- src/pods/advisory-validation.test.ts (new).
- src/validation/advisory-browser-qa-runner.test.ts.
- src/pods/readiness-review.test.ts.

Inherited exact command: .autopod-data/runtime-resume-context/affected-command.json.
Planning records the resolved 95-suite command. Existing validation repository,
progress, engine, operator guidance and lifecycle suites remain included. No missing
standalone nudge/ownership test file is assumed; the new direct/SQLite tests cover them.

Full uncached qualification includes frozen install, lint, build, supported declaration
typecheck, tests, audit and secret scan with SQLite enabled. Preserve the existing
process-only maintenance.auto=false and root lint processing limit 2 MiB; no rule,
file selection, repo/global configuration or lock mutation. Preserve/investigate any
failure before unchanged rerun. The previous 8,467 passing Vitest tests/35 script
checks and 10 gated skips are baseline evidence, not results of this slice.

Recheck body/call recipe, scope and hashes after qualification. Complete plan with
observed results and limits; commit/push verified increments and confirm clean
checkout/remote identity. Final docs-only commit preserves qualified source bytes.
Update roadmap status only after the numbered outcome is proven complete.

### Success criteria

Automated:
- [ ] All 95 affected suites pass unfiltered with real SQLite and no new skips.
- [ ] Full uncached pipeline passes in the documented environment.
- [ ] Scoped types/lint/whitespace, exact movement, source scope and frozen hashes pass.
- [ ] Completed proof/plan/roadmap record actual counts, limits and clean pushed revision.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public tests establish actual entry-point wiring and approval/cleanup visibility.
Direct tests isolate scheduling/publication/error/reference behavior. Real local
repositories and reopen checks establish durable history/usage boundaries. Existing
browser QA runner tests retain their controlled engine scope. No faster execution,
stronger authorization, atomicity, isolation, replay/crash safety or live browser
quality claim. No migration. Roll back manager composition and new module together.
No unresolved design choice. Next action: explicit approval, then all three phases.
