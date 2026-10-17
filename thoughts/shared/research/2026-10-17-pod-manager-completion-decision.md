---
date: 2026-10-17
researcher: Codex
git_commit: f84f255e57c90a194386e291d59b4b3012467537
branch: codex/pod-manager-workspace
repository: autopod
topic: Source completion decisions after preparation
status: complete
---

# Research: completion decisions

## Question and current state

What remains between source preparation and validation, and which observable rules
and shared helpers does this boundary use? References below are relative to
packages/daemon/src/ at f84f255e. The managed worktree was clean on inspection.

pod-manager.ts has 17,811 lines. handleCompletion (:11108) checks native Goal
achievement/termination, rejects already-past-running statuses, invokes the human
gate, and routes/coalesces artifact output. It then awaits prepareSourceForCompletion
(:11150). An undefined result stops completion. The returned object contains
sandboxCheckpoint, sandboxCanonicalOutcome and sandboxHostProof. The interface is
currently private to completion-source.ts:10; the runtime preparation is unchanged
from completed slice 5.

## Decision inputs

The contiguous remaining decision region is pod-manager.ts:11156–11259. It reloads
the current pod and execution settings before evaluating policy. noChanges uses
the original pod's target and worktree presence: sandbox uses canonical outcome
unchanged; local uses worktree presence and freshly stored filesChanged === 0.
forceSandboxValidation instead uses the refreshed target and canonical changed.
The original/refreshed distinction is present in the code and is not a new fencing
or ownership guarantee.

Fork means linkedPodId is truthy, or baseBranch is non-null and differs from the
resolved defaultBranch. This comparison has no fallback to main. Scheduled means
scheduledJobId !== null. Rework means noChanges plus lastCorrectionMessage starting
with REWORK_IN_PROGRESS_PREFIX (:395). Validation disabled means skipValidation,
options.validate === false, or getPodValidationSuite(pod) === off (:1847–1856).
The latter helper defaults the suite to off for validate:false, otherwise full.

## Ordered actions

1. Successful sandbox proof/decision telemetry is logged before the branches when
   the original target is sandbox and checkpoint/outcome are present. It includes
   bounded commit/tree strings, current statistics and predicate flags. Its summary
   lifecycleDecision/cleanupSelected expressions do not include the Rework exception;
   validationSelected/prEligible do not encode every validation-disabled case.
   These are the existing expressions, not an authoritative decision result.
2. No-change Rework with validation enabled, not forked and not scheduled fails.
   It sets completedAt and the exact correction message. No cleanup, completion
   event or dependent notification is performed by this branch.
3. No changes, not forked, validation enabled completes directly. It emits activity,
   awaits cleanupContainer(refreshed, no-changes-complete), transitions complete
   with a timestamp and null correction, emits completion with explicit file count
   zero, then calls maybeTriggerDependents with the transition's returned pod.
4. Disabled validation without forced sandbox validation, OR no changes and not
   forked, bypasses validation. It preserves the no-change/off activity rules,
   transitions validating, reloads the pod, transitions validated clearing correction,
   and calls maybeTriggerDependents. It does not set completedAt or emit completed.
5. Remaining cases await this.triggerValidation(podId). A changed sandbox cannot
   bypass blocking validation through the skip/off preference. An unchanged fork
   validates when enabled, but can bypass when disabled. Scheduled exemption only
   changes the Rework failure rule; it does not force validation.

## Shared connections

- transition (:6394) validates transitions, persists updates, marks completion
  journal state, publishes status via afterCommit and refreshes readiness where
  applicable. It is widely shared and remains a manager helper.
- cleanupContainer (:3539) owns bounded provider cleanup and captured resource
  identity; cleanup failure handling belongs there. This boundary awaits it.
- emitPodCompletedEvent (:6456) constructs the existing completion event.
- maybeTriggerDependents (:6911) reloads parent state, handles fan-in/shared branches,
  and enqueues eligible children. It is shared with other successful paths.
- getPodValidationSuite/isPodValidationDisabled and REWORK_IN_PROGRESS_PREFIX have
  other callers. triggerValidation (:13436) owns actual validation admission,
  orchestration, retries and cancellation, outside this decision region.
- Factory composition after completion-source (:5499) is an existing local pattern.

## Existing evidence and test locations

pod-manager.test.ts:12211–12380 covers direct no-change completion, sandbox outcomes,
unavailable proof, fork base scope and bounded telemetry. :13884–13955 covers failed
no-change Rework and successful scheduled Rework. The completion source compatibility
group (:25946) has seven downstream-policy modes and exercises public completion
using actual SQLite plus controlled infrastructure. Manager spies observe the
public triggerValidation boundary. Direct source tests use real Git and file SQLite.
completion-human-gate.test.ts demonstrates file-backed SQLite close/reopen fixtures.

The completed slice 5 qualified 1,225 affected tests and the full uncached pipeline
(7,402 Vitest plus 35 Node tests), with 10 pre-existing gated skips. These are prior
results, not tests of a slice 6 change. No product/test files changed and no test
execution was performed during this planning pass.

## Open questions

None. The companion plan fixes the extraction boundary and verification approach.
