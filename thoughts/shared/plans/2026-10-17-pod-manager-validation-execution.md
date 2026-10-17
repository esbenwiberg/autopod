# Slice 9: validation execution and infrastructure retry extraction

Status: IN PROGRESS — explicitly approved; Phase 1 complete.
Baseline: 5cef752cadbf76390caedceec03c60217ee8283c.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.

## Overview and authority

Extract the existing shared validateWithInfrastructureRetries helper into
validation-execution.ts. Give engine invocation, durable retry admission and
infrastructure retry handling one module, preserving current behavior.
Use the established characterize → extract → qualify structure. Explicit approval
of this plan covers all three phases together, without an intermediate manual gate.
The user explicitly approved this concrete plan. Commit and push verified increments per the
user's repository instructions.

## Current state analysis

Research: ../research/2026-10-17-pod-manager-validation-execution.md.
At baseline, pod-manager.ts:6744–6872 contains one 129-line helper already called
by ordinary validation (:13693) and manual revalidation (:14919). It accepts an
existing ownership object and controller; the manager claims/releases them. The
helper attaches an evidence collector, records provenance, captures retry identity,
admits/starts/settles the retry ledger and executes the engine with owned callbacks.
It retries only typed retryable infrastructure results. Later admission refusal
retains the last executed result; initial refusal propagates.

## Desired end state and scope

Exactly two product paths change:

- New packages/daemon/src/pods/validation-execution.ts.
- packages/daemon/src/pods/pod-manager.ts: imports, factory composition and removal
  of the one helper definition. Both existing invocation sites remain unchanged.

Exactly two test paths change:

- packages/daemon/src/pods/pod-manager.test.ts: public baseline characterization.
- New packages/daemon/src/pods/validation-execution.test.ts: direct contract and ledger proof.

The manager retains claimValidation, controller map, lifecycle guards, phase event
builders, ownedValidationCallbacks, withReviewerLaunchPreflight, provenance helper,
provider resolution, unexpected-result constructor, classification/labels, input
preparation, workspace/evidence handling, retry parking, status/results and delivery.
Do not move shared helper implementations or change their other callers.
No new retry policy, lifecycle state, ownership fence, transaction, ledger/schema,
API, profile field, dependency, provider, deployment, PR or main integration.
No separate Git-maintenance or audit-clock test fix.

## Implementation approach

Create createValidationExecution with these 14 narrow existing collaborators.
Use ValidationEngineConfig and ValidationPhaseCallbacks from the existing interface;
Ownership below means ReturnType<typeof captureValidationOwnership>.

1. logger: Logger.
2. containerManagerFactory: { get(target: ExecutionTarget): ContainerManager }.
3. podRepo: Pick<PodRepository, 'getOrThrow' | 'update' | 'taskRetries'>.
4. validationEngine: Pick<ValidationEngine, 'validate'>.
5. retrySource: {
     validationInfrastructureRetryBackoffMs?: readonly number[];
     captureRetryIdentity?(config: ValidationEngineConfig): Promise<TaskRetryIdentity>;
   }.
6. recordValidationProvenance(config: ValidationEngineConfig, purpose: 'validation', assertCurrent: () => Pod): Promise<void>.
7. resolveEffectiveBoundProfile(pod: Pod): PodExecutionSettings.
8. withReviewerLaunchPreflight(config: ValidationEngineConfig, ownership: Ownership): ValidationEngineConfig.
9. ownedValidationCallbacks(ownership: Ownership, callbacks: ValidationPhaseCallbacks | undefined): ValidationPhaseCallbacks.
10. emitActivityStatus(podId: string, message: string): void.
11. makeUnexpectedValidationFailureResult(podId: string, attempt: number, error: unknown): ValidationResult.
12. validationInfrastructureFailureLabel(result: ValidationResult): string.
13. isReviewInfrastructureOnlyFailure(result: ValidationResult): boolean.
14. reviewInfrastructureFailureLabel(result: ValidationResult): string.

Import existing createHash, timers/promises setTimeout as sleep,
captureValidationRetryIdentity, createValidationIdentityCollector, waitForRetryBackoff
and TaskRetryBlockedError from their existing modules. Import ownership only as a
type dependency. No circular import or new export from pod-manager.ts.

Return the exact existing operation/signature:

    validateWithInfrastructureRetries(
      validationConfig: Parameters<ValidationEngine['validate']>[0],
      validationController: AbortController,
      callbacks: Parameters<ValidationEngine['validate']>[3],
      logMessage: string,
      ownership: ReturnType<typeof captureValidationOwnership>,
    ): Promise<ValidationResult>

Move the entire helper unchanged except two receiver substitutions:

- deps.validationInfrastructureRetryBackoffMs → retrySource.validationInfrastructureRetryBackoffMs.
- deps.captureRetryIdentity → retrySource.captureRetryIdentity.

Pass the original manager deps object as retrySource. Read backoffs once per
invocation at the same point and the current optional capture callback on each
run. Retain backoff reference/iteration behavior and the existing copy passed to
ledger.admit. Do not cache these properties at factory construction.

Compose immediately after createValidationInputs. Factory construction does no
I/O or ledger/map mutation. Bind its returned validateWithInfrastructureRetries
name in manager scope and remove the old definition; no wrapper at either call
site and no extra await. Remove only the two identity-helper manager imports if
unused after extraction. Retain timers/hash/backoff imports used by other code.

Allow typed wrapper/imports/composition, the two receiver substitutions, original
helper removal and formatting only. Compare the complete remaining manager and
new module to that explicit recipe using parsed TypeScript tokens. No normalization
of classifications, outcome precedence, messages, catch boundaries or helper calls.

## Compatibility requirements

1. Preserve initial ownership assertion and target fallback. Attach the evidence
   collector with ??= on the original config; keep an existing collector's identity.
   Evidence identity and retry identity remain separate mechanisms.
2. Every run keeps provenance → retry identity → current bound-profile check →
   binding hash → admission → persisted cooldown → start → engine → finish → final
   ownership assertion. Hash JSON property order and snapshot inputs remain identical.
3. Preserve four engine arguments, original signal, caller-specific log message,
   preflight callbacks and ownership-filtered progress/phase/review events. A throw
   within the current engine try is logged and converted by the existing constructor;
   errors outside it retain their original propagation/ownership precedence.
   ledger.start precedes reviewer preflight; a preflight failure is converted after
   the start marker even when the engine is never called. Preserve that boundary.
4. Keep persisted admission deadlines and shared early/stalled-clock handling.
   Cancellation before start settles cancelled/null and does not run checks.
   A result from already executed work settles with measured duration before a
   superseded result is rejected. Do not erase honest historical work.
5. Preserve settlement precedence: abort, pass, typed retryable or review-only
   infrastructure, then nonretryable. Review-only classification by itself does not
   satisfy the loop's infrastructureFailure.retryable predicate. Keep final label text.
6. Preserve zero/default/configured backoffs and no-ledger behavior. No ledger skips
   retry-identity capture and uses direct positive sleeps. With a ledger, keep its
   captured reference and task-wide policy; do not reset budgets per manager call.
7. First admission refusal propagates. A later TaskRetryBlockedError emits the error,
   writes failureReason and returns the last executed result by identity. Other
   later errors propagate. Preserve partial writes and cleanup-error precedence.
8. The manager alone still claims/releases controllers, rejects stale final results,
   publishes result/history, parks failures and chooses correction/delivery. Manual
   and ordinary caller differences remain. No stronger atomicity/crash/concurrency
   guarantee is asserted by this extraction.

## Phase 1: characterize the public execution boundary

Only change pod-manager.test.ts. Add a `validation execution compatibility` group
using public triggerValidation and revalidateSession with the existing real SQLite
manager context. Reuse the existing retry/ownership/provider cases where adequate.
No import of the future module and no new product seam. Keep results distinguishable
and inspect actual ledger admissions/outcomes, events, history and engine calls.

Cover both public entry paths as appropriate:

- First-run pass, deterministic failure, typed retryable failure then pass, exhausted
  infrastructure failure and thrown engine errors. Pin caller-specific failure/log
  behavior and that infrastructure retries do not resume the agent or consume a
  separate display attempt/history row for every inner engine invocation.
- Empty and explicit retry schedules, default schedule, persisted nonzero delay,
  early clock wake, no-ledger fallback and missing custom identity capture. Keep
  existing fixtures' actual capabilities explicit; do not invent a legacy policy.
- Provenance/identity ordering and selected binding; optional capture replacement
  after manager construction and between retries retains late property reads.
  Verify actual preflight/owned callbacks, signal identity and collector retention.
- Initial retry refusal versus refusal after an executed infrastructure failure;
  retain the prior result and refusal reason only in the latter path. Include
  task-wide exhaustion across repeated/manual invocations through existing cases.
- Replacement or pending guidance during identity capture/cooldown/engine execution;
  cancellation before execution versus after execution; no stale progress, result,
  stopping or controller cleanup affects a replacement invocation. Reuse existing
  validation admission lifecycle ownership cases; test callbacks on held work.

Hold existing engine/identity/timer seams only. Release and join in finally; restore
Date/timers/spies/env and close private databases. Pin baseline observations rather
than improve surprising behavior. Freeze public assertions, package/script hashes,
runtime, selected case names and passing raw before results under ignored
.autopod-data/validation-execution/. Preserve earlier slices' receipts.

### Success criteria

Automated:
- [x] New public cases and selected existing execution/ownership cases pass on unchanged product.
- [x] Frozen public/product identities, actual runtime/SQLite and raw before results are recorded.

Manual: None required for this headless compatibility boundary.

## Phase 2: extract and prove execution and durable admissions

Apply the exact two-file product move. Keep Phase 1 assertions byte-identical.
Add validation-execution.test.ts importing the actual factory with private migrated
file-backed SQLite and real pod/task retry repositories. Use real
captureValidationOwnership wired to the stored pod and a controlled invocation
predicate where ownership is claimed. Manager tests prove its actual map/decision
wiring. Use existing container/engine seams; no live provider or cloud resource.

Direct evidence must cover:

- Factory has no side effects. Exact container selection/fallback and collector
  attachment preserve config identity and an existing collector; prove the real
  fallback identity path through controlled container exec output and existing
  identity suites. Do not claim synthetic hashes prove live container provenance.
- Successful, transient, nonretryable and cancelled admissions persist across
  actual close/reopen; run integrity_check and foreign_key_check. Verify sequence,
  executedCount versus admissionCount, outcomes and nonnegative measured duration.
  Observe cancelled-before-start null duration separately from cancelled executed work.
- Persisted cooldown, early wake and ownership/abort checks using Date-only fake
  clocks and controlled existing timer import. Restore real clocks after each case.
  Real admission refusal/exhaustion retains honest prior execution and selected policy.
- Replacement during provenance, identity, cooldown or engine work; saved historical
  outcome before superseded rejection; no publication is invented inside the helper.
  Retain exact result identity and error precedence, including current ownership
  assertion replacing an error only where it already does so.
- First/later admission errors, start/finish failures and engine/preflight exceptions
  preserve partial effects and error/conversion boundaries. Actual ledger cases
  prove ledger policy; controlled failures prove collaborator contract only.
- Review-only versus typed retryable classification, abort precedence, default/empty
  backoffs, no-ledger positive sleep, optional callback lookup timing and caller log
  messages. Callback/phase/reviewer internals stay in manager and retain existing tests.

Use the existing module import for timers and narrow infrastructure seams; do not
add production-only injectable clocks, identity policies or exported hooks. Record
exact movement and actual line counts, verify all other baseline files unchanged.

### Success criteria

Automated:
- [ ] Frozen public checks pass unchanged after extraction.
- [ ] Direct contract and real SQLite admission/outcome/close-reopen checks pass.
- [ ] Exact movement, unchanged helpers/call sites and four-path product/test scope pass.

Manual: None required. Live provider/container availability is outside this proof.

## Phase 3: qualify frozen final source

Use the established ignored task launcher with Node 22.23.3 / pnpm 9.15.4. Confirm
actual child runtime and opened SQLite. Freeze all final package/test/script hashes;
compare after qualification. Retain raw commands, exit codes, counts/skips, initial
failures/corrections and limitations in .autopod-data/validation-execution/.

    npx pnpm --filter @autopod/daemon exec node -p process.execPath
    npx pnpm --filter @autopod/daemon... build
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/pod-manager.test.ts -t 'validation execution compatibility|validation admission lifecycle ownership|validation infrastructure|review infrastructure|persisted backoff|task-wide transient validation|actual validation invocation|non-container reviewer launch|forced revalidation'
    SKIP_DB_TESTS=0 npx pnpm --filter @autopod/daemon exec vitest run src/pods/validation-execution.test.ts
    npx pnpm exec biome check --files-max-size=2097152 packages/daemon/src/pods/pod-manager.ts packages/daemon/src/pods/pod-manager.test.ts packages/daemon/src/pods/validation-execution.ts packages/daemon/src/pods/validation-execution.test.ts
    git diff --check
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=maintenance.auto GIT_CONFIG_VALUE_0=false TURBO_FORCE=true SKIP_DB_TESTS=0 ./scripts/validate.sh

Run the predecessor's explicit 43-file affected set plus these five verified paths,
without name filters (48 suites total):

- src/pods/validation-execution.test.ts
- src/pods/retry-backoff-wait.test.ts
- src/pods/execution-provenance-ledger.test.ts
- src/validation/retry-identity.test.ts
- src/validation/validation-identity-collector.test.ts

Save the fully expanded affected command and results. The full pipeline must run
uncached with successful frozen install, unchanged lockfile, lint, build, supported
declaration typecheck, tests, audit and secret scan, with SQLite enabled.

Carry the two documented process-only harness settings from slice 8:
- maintenance.auto=false avoids the reproduced lock-file metadata-scan race.
- The task npx launcher adds only --files-max-size=2097152 to root lint so the
  existing large manager test is processed. Rules and file selection stay enabled.

Do not modify global/repository configuration or suppress failing assertions. If the
unrelated audit-clock test recurs, preserve the raw failure and establish its cause
before an unchanged rerun; do not change its clock/assertions or claim it fixed.
The same rule applies to other failures: investigate before retrying, and record
unresolved limitations honestly. No passing results are assumed from predecessors.

Review the final diff, recheck frozen hashes, update this plan's evidence, commit
and push verified increments, and verify final remote identity and clean worktree.

### Success criteria

Automated:
- [ ] All 48 affected suites pass with SQLite and no new skips.
- [ ] Full uncached pipeline passes under the documented qualification environment.
- [ ] Scoped lint/whitespace, new-test semantic diagnostics, frozen hashes and movement review pass.
- [ ] Evidence and final plan record actual results, limitations and pushed identities.

Manual: None required. Approval covers all three phases together.

## Testing strategy, performance, migration and rollback

Public tests prove actual manager composition, shared helper use and stale/cancel
handling. Direct tests prove the extracted call boundary and real persisted retry
admissions/outcomes. Existing identity/provenance/backoff suites protect internals.
No live provider/container, stronger fencing/atomicity or new crash-recovery proof.

Keep the same probe, call, await, retry and timer counts and persisted deadlines.
The operation is directly bound from a factory; no extra invocation wrapper/await
is introduced. No performance gain is claimed. No schema/API/dependency migration.
Revert module and manager wiring together. Main integration remains separate work.

## References and next action

- Research: ../research/2026-10-17-pod-manager-validation-execution.md.
- Predecessor: 2026-10-17-pod-manager-validation-inputs.md (complete).
- Sources: pod-manager.ts:6744–6872 and its two existing callers; validation-ownership.ts;
  task-retry-ledger.ts; retry-backoff-wait.ts; validation identity modules.

Next action: review and explicitly approve this concrete plan, then execute all
three phases together. No implementation or test execution has started.

## Phase 1 evidence

30 new public cases and 39 selected existing execution/retry/ownership cases passed
on unchanged product source: 69 passed, 913 name-filtered. Public assertions and
all baseline package/script identities are frozen under ignored
.autopod-data/validation-execution/. Actual Node 22.23.3 opened SQLite 3.49.2.
Scoped Biome is clean with the approved 2 MiB processing limit; supplemental
semantic diagnostics in the new public group are zero.

Initial baseline failures are retained: eight new timer assertions included old
mock-call history from preceding tests. The fixture now clears that history.
A review-infrastructure helper returns Partial<ValidationResult>; the new test now
supplies the standard complete result defaults. These fixture/type corrections
preceded the final passing baseline and freeze; no product behavior changed.
The selected filter also includes the existing authorized-later-admission case.
