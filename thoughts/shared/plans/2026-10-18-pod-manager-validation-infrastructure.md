# Slice 12: validation infrastructure classification and parking extraction

Status: APPROVED — Phases 1 and 2 complete; final qualification running.
Date: 2026-10-18.
Baseline: 86380d0ff76f126f8e60d245447f4a2718f8c4a5.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Give infrastructure classification, labels and the three existing parking helpers
one module. Preserve their distinct attempt accounting, shutdown order and error
boundaries. Callers continue to choose when to park; retry budgets remain separate.

Use the established characterize → extract → qualify structure. Approval covers all
three phases together, with no intermediate manual acceptance for this headless
extraction. Commit/push verified increments per the user's repository instructions.
Planning changes no product code.

## Current state analysis

Research: ../research/2026-10-18-pod-manager-validation-infrastructure.md.
Manager baseline: 17,343 lines. Four pure classification/label functions occupy
pod-manager.ts:956–1006 (51 lines including trailing blank). Three parking helpers
occupy :6775–6842 (68 lines including trailing blank). Their eight awaited call sites
span ordinary/manual validation, early sandbox failure and independent council review.
The classifiers also feed execution handling and validation-only Resume routing.

The paths differ: denied admission guards validating, records failureReason and
refunds one displayed attempt; validation infrastructure refunds and clears correction
text; reviewer infrastructure retains attempts and correction text. Each uses existing
manager transition/preview callbacks. None changes the durable retry budget itself.

## Desired end state and scope

Exactly two product paths change:
- New packages/daemon/src/pods/validation-infrastructure.ts.
- packages/daemon/src/pods/pod-manager.ts: imports, factory composition and removal
  of the seven original function definitions. Existing calls/arguments remain unchanged.

Exactly two test paths change:
- packages/daemon/src/pods/pod-manager.test.ts: public baseline characterization.
- New packages/daemon/src/pods/validation-infrastructure.test.ts: classifier/label
  matrix, parking contracts and real SQLite partial-effect proof.

The manager retains lifecycle/controllers, transition/readiness/event implementation,
preview maps and teardown implementation, admission/ownership policy, engine retries,
provenance, source/evidence/publication, council decisions, Resume routing and delivery.
Other inline review shutdown branches remain unchanged. No new retry policy, display
attempt policy, state/schema/API/profile/dependency, idempotency, transaction, outbox,
provider call, PR, main integration or deployment.

## Implementation approach

Move and export the four PURE functions unchanged:

    isValidationInfrastructureOnlyFailure(result: ValidationResult): boolean
    validationInfrastructureFailureLabel(result: ValidationResult): string
    isReviewInfrastructureOnlyFailure(result: ValidationResult): boolean
    reviewInfrastructureFailureLabel(result: ValidationResult): string

Import those same names in manager. Keep createValidationExecution receiving the same
names; its module, helpers and call sites remain unchanged. New exports are confined
to this internal module, with no shared or manager API export.

Add createValidationInfrastructure with six narrow collaborators:
1. logger: Pick<Logger, 'info' | 'warn'>.
2. podRepo: Pick<PodRepository, 'update'>.
3. containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager }.
4. transition(pod: Pod, to: 'review_required', extraUpdates?: Partial<PodUpdates>): Pod.
5. stopSandboxPreviewProxy(podId: string): Promise<void>.
6. emitActivityStatus(podId: string, message: string): void.

Use existing type imports for Pod, ValidationResult, Logger, ContainerManager,
PodRepository/PodUpdates and TaskRetryBlockedError. The error class remains the
original manager runtime import for instanceof checks; no replacement class.
Factory construction has no I/O, status/ledger/map mutation or collaborator calls.
Capture the same objects/functions, preserving later method lookup timing.

Return these exact existing signatures and helper bodies:

    parkOnRetryAdmission(pod: Pod, error: TaskRetryBlockedError): Promise<void>
    parkOnValidationInfrastructureFailure(pod: Pod, result: ValidationResult): Promise<void>
    parkOnReviewInfrastructureFailure(pod: Pod): Promise<void>

Compose immediately after createValidationPublication. Destructure the three names
into manager scope and remove their old definitions. Keep all EIGHT existing awaited
calls byte/token-equivalent, with no wrapper or new await. Existing classification/
label uses and injections keep their arguments and order. No body receiver changes
or helper normalization is needed.

Compare parsed TypeScript tokens for all seven moved bodies and the entire remaining
manager against this explicit recipe. Allow type/imports, pure-function export
modifiers, typed factory wrapper/composition, original definition removal and
formatting only. Independently verify eight unchanged parking calls and all unchanged
classifier/label uses. Preserve adjacent inline branches/shared implementations.

## Compatibility requirements

1. Preserve exact predicates and label precedence. Typed validation metadata does
   not need retryable=true or otherwise-clean deterministic phases to classify.
   Review classification retains its null/strict-true checks, build-pass requirement,
   allowed skips and exclusions for failed/pending-human deterministic evidence.
2. Denied admission alone has the initial validating-status no-op guard. Its activity
   precedes transition with failureReason, then refund with Math.max(0, snapshot-1).
   Retain correction text. Do not add a stopping activity or success log to this path.
3. Validation infrastructure emits its label before transition, refunds one displayed
   attempt and clears lastCorrectionMessage. Review infrastructure only transitions;
   retain its attempt/correction/reason behavior. No implicit clearing of failureReason.
4. Use passed snapshot counts/fields even if transition returns or subscribers persist
   different values. No fresh pod lookup, transaction or stronger concurrency claim.
5. Only a present container runs teardown: await original preview callback → select
   existing target manager → await stop. Keep activity/log placement, metadata, catch
   messages and error precedence. Proxy failure prevents stop; success-log failure
   stays inside stop catch. A throwing warning can escape. No retry/kill/removal.
6. Activity/transition/update failures outside stop try retain partial effects and
   propagation. An update failure after transition leaves parking persisted and
   prevents teardown. Caller error handling, state validation and readiness stay intact.
7. Durable retry admission/outcomes, ownership and classification-dependent Resume
   routing keep their existing policy. Moving predicates changes no authority to
   execute checks or resume an agent. Other inline shutdown paths remain separate.

## Phase 1: characterize public parking and routing

Only edit pod-manager.test.ts. Add a `validation infrastructure compatibility` group
using public triggerValidation/revalidateSession/Resume as appropriate with the
existing migrated SQLite context. No future-module import or product-only seams.
Reuse existing admission/execution/ownership cases rather than recreate policy.

Cover both entry paths where applicable:
- Typed infrastructure failure (including nonretryable), review timeout/failure,
  unavailable council and closure, and deterministic failures that must not be
  misrouted. Pin status, displayed attempts, correction/failure reason, history,
  event order, engine/resume counts and current container stop behavior.
- Exhausted/denied admission versus executed infrastructure work, including existing
  task-wide Resume/restart checks. Demonstrate display refunds do not replenish the
  retry ledger or launch agent correction.
- Missing container, local/sandbox target, existing preview teardown ordering where
  reachable, and stop failure keeping a parked result. Use existing container/proxy
  seams only; hold/release/join any asynchronous work in finally.
- Controlled transition/refund failure and reachable activity/logger failure: retain
  earlier persistence and original outer handling. Do not accidentally fail unrelated
  setup/admission writes. Observe actual behavior before freezing expectations.
- Retain selected existing council/closure, early sandbox unavailable, review retries,
  persistent infrastructure and validation-only Resume cases to cover unchanged call sites.

Close private databases, unsubscribe callbacks and restore spies/clocks/env. Freeze
passing public assertions, selected names, all baseline package/script and root
control hashes, actual Node/pnpm/SQLite and raw before results under ignored
.autopod-data/validation-infrastructure/. Retain initial failures/corrections honestly.

### Success criteria

Automated:
- [x] New and selected existing public checks pass against unchanged product.
- [x] Frozen assertions/source/runtime and raw before evidence are recorded.

Manual: None required for this local headless extraction.

## Phase 2: extract and prove classification, parking and partial effects

Apply the exact two-product-file move. Keep Phase 1 assertions byte-identical.
Add validation-infrastructure.test.ts importing actual exports/factory. Classifier
cases use complete typed results; no production-only classifier or clock hooks.

Direct classification/label matrix covers overall state, typed metadata presence,
retryable/nonretryable, review-null versus non-null, council/closure conditions,
label precedence, deterministic blockers and allowed skip/absent values. Preserve
current expressions and known distinctions; no consistency-policy improvement.

Parking tests use private migrated file-backed SQLite and actual pod repositories.
The injected transition fixture uses real validateTransition plus repository/event
operations for the callback contract; it is NOT the actual manager transition or
readiness implementation. Public tests prove those actual manager integrations.
Use controlled preview/container seams; reopen database and run integrity/FK checks.

Direct parking matrix:
- Construction no effects; exact arguments, snapshot/ref identities, target lookup,
  ordered activity/transition/update/preview/stop/log and captured callback/object
  references with late method lookup.
- All three paths with/without container; denied-admission non-validating no-op;
  positive/zero refund clamp; unchanged review count/correction/reason. Transition
  return and synchronous subscriber changes do not replace the original snapshot.
- Real SQL failure in transition or refund/update proves durable prefix and absence
  of later teardown after reopen. Record callback-fixture limits; no new transaction.
- Held preview completes before stop. Preview/factory/stop rejection, success logging
  error, and throwing warning retain exact continuation/escaping-error behavior.
  Initial and stopping activity errors retain their different catch boundaries.
- Invalid transitions and injected transition/update/activity failures retain original
  error identity and partial effects. Do not combine catch blocks or suppress errors.

Keep real ownership/ledger/readiness/preview implementations unchanged and rely on
existing surrounding suites for their internals. Record exact movement, line counts,
unchanged eight parking calls and classifier/label uses, and all other baseline files.

### Success criteria

Automated:
- [x] Frozen public checks pass unchanged after extraction.
- [x] Direct classifier/contracts and real SQLite close/reopen/failure checks pass.
- [x] Seven-body movement, unchanged uses/calls and two-product/two-test scope pass.

Manual: None required. No live Docker/Azure/provider claim.

## Phase 3: qualify frozen final source

Use the existing task-local launcher: Node 22.23.3 / pnpm 9.15.4, verifying actual
child runtime and opened SQLite. Freeze final package/script and six root control
hashes. Retain raw commands/exits, actual counts/skips, and failures/corrections.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'validation infrastructure compatibility|review infrastructure|validation infrastructure|frozen council infrastructure|unavailable prior-finding closure|exhausted task-wide transient|infrastructure-blocked|review-council-infrastructure-blocked|validation admission lifecycle ownership|validation execution compatibility|sandbox status'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/validation-infrastructure.test.ts
    npx pnpm exec biome check --files-max-size=2097152 packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/validation-infrastructure.ts packages/daemon/src/pods/validation-infrastructure.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Run the predecessor's explicit 56-suite affected set plus these four distinct paths,
without name filters (60 suites):
- src/pods/validation-infrastructure.test.ts (new in Phase 2).
- src/pods/sandbox-preview-proxy.test.ts.
- src/pods/preview-supervisor.test.ts.
- src/api/routes/pods.test.ts.

Save the fully expanded command. Full pipeline runs uncached with successful frozen
install, unchanged lockfile, lint, build, supported declaration typecheck, tests,
audit and secret scan. SQLite stays enabled; no new skips. Supplemental semantic
checking covers the new test boundaries without claiming old broad-test typing fixed.

Carry process-only maintenance.auto=false and root lint --files-max-size=2097152.
Change no repository/global configuration, rules or file selection. Preserve and
investigate failures before an unchanged rerun; existing Git maintenance scan race
and audit-clock flake remain outside scope. No slice 11 result substitutes for a run.

Review final diff/movement, recheck frozen hashes, update plan/proof with actual
results/limits, commit/push verified increments and confirm remote identity/clean tree.

### Success criteria

Automated:
- [x] All 60 affected suites pass with SQLite and no new skips.
- [ ] Full uncached pipeline passes under the documented qualification environment.
- [ ] Scoped lint/whitespace, new-test semantic diagnostics, movement and hashes pass.
- [ ] Completed plan/proof records actual results, limitations and pushed identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public baseline proves actual manager transitions/readiness/routing. Direct tests
prove pure predicates and injected parking contracts plus real SQLite prefix effects.
Controlled preview/container seams prove order/errors, not live external availability.

Keep original async signatures, internal awaits and all existing awaited calls. No
performance gain, new fencing, atomicity, recovery or idempotency is claimed. No
schema/API/dependency migration. Revert manager wiring and new module together.
Integration, PR creation and deployment remain separate work.

## References and next action

Research: ../research/2026-10-18-pod-manager-validation-infrastructure.md.
Predecessor: 2026-10-18-pod-manager-validation-publication.md (complete).
Sources: pod-manager.ts:956–1006, :6775–6842, :3804 and transition; state-machine.ts;
task-retry-ledger.ts and existing infrastructure/Resume/ownership tests.

Next action: qualify the frozen implementation with the full uncached pipeline.

## Phase 1 observed results

28 new public cases and 62 selected existing cases pass (90 selected total) against
unchanged product. The selection run excludes 962 unrelated cases; the affected/full
runs will run complete suites. Runtime is Node 22.23.3 and SQLite 3.49.2. Baseline
1,967 package/script hashes, six root controls, before manager, frozen public bytes,
filter and raw logs/exits are retained privately.

Initial baseline expectations had eight failures: six manual entry cases already
clear failureReason before parking; two refund failures persist review_required and
the caller then throws InvalidStateTransitionError attempting review_required→failed.
Assertions now capture those observed contracts. One event-union type guard was
corrected. No product behavior was changed. Public semantic diagnostics are zero.

## Phase 2 observed results

Extracted four pure functions and three async parking helpers unchanged into the
154-line validation-infrastructure.ts, with six narrow dependencies. Manager is
17,244 lines (99 fewer). Parsed TypeScript proves all seven exact original bodies,
the complete remaining manager against the explicit recipe, all eight unchanged
awaited calls (3 validation, 3 review, 2 admission), and unchanged classifier/label
uses. All 1,965 other baseline package/script files are unchanged.

The frozen 90 public cases pass unchanged after extraction. All 94 direct cases pass:
36 classifier/label cases and 58 parking contract cases use controlled collaborators
and real migrated file-backed SQLite. Tests preserve the injected-transition fixture
limit: real state validation/repository/events, not manager readiness implementation.
Public tests cover actual manager integration. SQL aborts, durable prefixes, reopen,
integrity/FK checks, held preview ordering, snapshot accounting, late methods, missing
containers, stop/log/activity boundaries and error identity are exercised.

All 60 affected suites pass: 2,182 tests, zero skips. Scoped Biome/whitespace and
semantic diagnostics in both new test boundaries pass. The direct tests passed on
first execution; six multiple variable declarations were split to satisfy Biome.
The temporary source-audit harness was corrected to handle import specifiers/type
signatures and to compare external classifier uses separately from exact moved
bodies. Product helpers and frozen public tests did not change. Raw diagnostics and
final passing receipts are retained privately.

Final source is frozen with 1,969 package/script hashes and six unchanged root
controls before full qualification. No new dependency/configuration/schema change.
