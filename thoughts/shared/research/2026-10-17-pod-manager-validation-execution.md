# Slice 9 research: validation execution and infrastructure retries

Date: 2026-10-17.
Baseline: 5cef752cadbf76390caedceec03c60217ee8283c.
Branch: codex/pod-manager-workspace.
Worktree: /Users/ewi/.codex/worktrees/pod-manager-workspace/autopod.
Scope: the shared validateWithInfrastructureRetries helper and its two callers.

## Current ownership

Eight slices are complete. validation-attempt-start.ts owns ordinary entry, and
validation-inputs.ts owns ordinary configuration assembly. The manager remains
17,625 lines. triggerValidation and revalidateSession keep distinct admission,
configuration and result paths, but already call the same execution helper.

packages/daemon/src/pods/pod-manager.ts:6744–6872 defines that 129-line helper.
Its signature accepts engine config, AbortController, phase callbacks, a caller
log message and existing ownership. It returns ValidationResult. The only callers
are ordinary validation (:13693) and manual revalidation (:14919). Each caller
claims ownership before invoking the helper, asserts it after return, and deletes
its controller only if the map still points to that controller. Ordinary validation
also checks the captured lifecycle before finalizing. All of that is outside the helper.

claimValidation (:6706) uses termination checks, captureValidationOwnership and the
manager-owned validationAbortControllers map. ownedValidationCallbacks (:6727)
filters phase/review events using ownership.isCurrent(). It is also used by advisory
QA and independent councils; moving it would affect more than these two invocations.
withReviewerLaunchPreflight (:6630) adds execution/provenance callbacks and checks
provider routing. Those shared helpers have separate callers and behavior.

## Exact execution sequence

The helper first asserts ownership, resolves the target container manager using
config.executionTarget or the stored pod target, and fills config.captureEvidenceIdentity
with ??=. An existing collector is preserved; a new collector is attached to the
same config object. Constructing it is not itself an external probe.

Next it reads deps.validationInfrastructureRetryBackoffMs, default [1000,5000],
and captures podRepo.taskRetries once. Each runValidation invocation:

1. Asserts current ownership and retains that returned pod snapshot.
2. Awaits recordValidationProvenance(config, 'validation', ownership.assertCurrent).
3. With a ledger, awaits the current optional deps.captureRetryIdentity callback or
   the existing container retry-identity capture fallback. Without a ledger it
   skips retry-identity capture. Evidence-identity and retry-identity are distinct.
4. Resolves the effective bound profile using a fresh ownership assertion. Computes
   the same SHA-256 JSON binding hash from the retained snapshot and reviewer fields.
5. With ledger and identity, admits using a copy of the selected backoff array.
6. Waits for admission.notBefore using shared waitForRetryBackoff and node timers.
   Rechecks ownership/abort during the wait and before ledger.start. A failure here
   calls finish(admission.id, 'cancelled', null) before propagating.
7. Measures execution duration. Within an inner try, builds reviewer preflight,
   progress and owned callbacks, then calls the engine with the controller signal.
   A throw here is logged and converted by makeUnexpectedValidationFailureResult.
   The ledger start marker already exists when preflight runs; started/executed
   accounting is not proof that the engine was called or that a check completed.
8. Settles the exact admission: aborted → cancelled; else pass → pass; else typed
   retryable infrastructure or review-only infrastructure → transient; else nonretryable.
   Duration is rounded performance.now delta. This settlement precedes the final
   ownership assertion. A superseded result may be discarded after honest history
   was saved. The outer run catch reasserts ownership before propagating an error.

The outer loop runs once initially, then iterates selected backoffs only while the
returned result has infrastructureFailure.retryable and the controller is not aborted.
The review-only classification affects settlement and final activity, but alone does
not make this loop retry. The fixed final review activity wording is existing behavior.

Without a ledger, the helper sleeps the configured positive waitMs directly. With a
ledger, admission's persisted deadline is authoritative. On later TaskRetryBlockedError,
it emits the error message, writes failureReason and returns the last actually executed
result. Initial admission failure propagates instead. Other later errors propagate.
No validation-history insertion, status transition, controller-map release or final
result publication is done here.

## Shared implementations

validation/retry-identity.ts captures content/commands/contract/environment/release
identity with unavailable fields remaining null. validation/validation-identity-collector.ts
creates an optional hermetic evidence collector. Neither implementation needs changing.

pods/retry-backoff-wait.ts bounds invalid/excessive deadlines and stalled/early clocks,
rechecking ownership on every wake. pods/task-retry-ledger.ts owns persisted membership,
identity, binding, policy, admissions and outcomes; it has real disk-reopen tests.
The manager's isReviewInfrastructureOnlyFailure (:969), failure-label helpers (:963,
:997), unexpected-failure constructor (:6520), provenance, provider resolution and
owned callbacks remain shared behavior in the manager.

The retry settings and optional capture callback are read from the original deps
object at their current times. Capturing their values at factory construction would
change behavior. Passing a narrow view of the original object preserves those reads.

## Existing evidence

pod-manager.test.ts covers bounded recovery (:16416), nonzero wait (:16444), early
wake (:16476), persistent failures/budget/external repair, forced manual revalidation,
provider/reviewer dispatch and the validation admission lifecycle ownership group
(:24153). The latter covers replacement during backoff or identity capture and late
results that retain ledger outcome without publishing into a replacement.

Direct supporting suites exist for task-retry-ledger, retry-backoff-wait, execution-
provenance-ledger, validation retry identity and validation identity collector.
The manager context uses real SQLite ledgers and mocked containers/providers.

Slice 8 passed 33 selected public, 40 direct and 1,651 affected tests. Its full
qualification passed 7,611 Vitest plus 35 Node tests, with 10 existing gated skips.
These are predecessor results, not slice 9 execution evidence. The same recorded
Node 22 / pnpm 9 launcher, process-only Git maintenance setting and Biome 2 MiB
processing limit apply to the next qualification. Slice 8 retained an unrelated
audit test failure across a one-second timestamp boundary, proved by reconstructing
both failure hashes; unchanged isolated and full reruns passed. That test remains unfixed.

No product/test changes or test runs occurred during this research. The companion
plan specifies a shared-helper extraction and its proof. No external decision is pending.
