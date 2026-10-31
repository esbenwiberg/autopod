# Validation timeout evidence and recovery

A validation timeout is an interruption, not an observed test exit. The Azure
streaming client retains its explicit timeout cause, configured budget in
milliseconds, partial output and measured validation duration. An unexpected
WebSocket close does not become a timeout merely because it happened near the
budget. Missing or invalid exit frames never establish successful execution.

Sandbox setup uses the same streaming command path as build/test, with the configured
`buildTimeout` in milliseconds and the supplied validation environment. This avoids
waiting for a single buffered setup response and retains partial stdout/stderr if
setup loses its exit result or times out. Local setup retains its buffered path.
Setup streaming does not grant retry permission, prove termination, or relax the
immutable dispatch/outcome and final-content preservation fences described below.

On timeout, the ordinary streaming wrapper's owned process group receives TERM,
with up to two seconds to exit, then KILL if necessary, with up to two seconds
for confirmation. Cleanup checks the recorded leader's process start time and
group before signalling; a missing/stale receipt fails closed. The cleanup API
request has a five-second timeout and makes a single attempt (no normal
rate-limit backoff). It can be rejected by providers that prohibit concurrent
buffered exec beside streaming exec. Validation waits for cleanup to settle.

`infrastructureFailure.execution` records `cause`, `timeoutMs` (when known), and
`cleanup` (`confirmed`, `failed`, or `unverified`). An `observedExitCode` is retained
only when an actual exit frame or supervisor receipt arrives, including during
cleanup. Output received during the grace period is retained too. These fields
are optional for old records. Confirmed process-group cleanup does **not** invent
an exit code or establish that tests passed. Prior failing assertions remain in
partial output; incomplete test status is not evidence that tests never ran.
Desktop shows the timeout budget, cleanup result and recovery guidance.
Cleanup-pending or retry-pending states require durable evidence. Desktop overview
and card summaries distinguish unknown execution outcomes, infrastructure failures,
review findings and actual exhausted attempt limits; a generic `review_required`
status alone is not evidence that the attempt budget was exhausted.

## Recovery boundary

Ordinary legacy validation execs do not have the durable, root-owned supervisor
receipt used by recorded native Goal processes. Suspending/stopping an Azure
sandbox is not proof that its processes exited. Reusing Goal recovery without
durable validation ownership, or deleting the workspace container before artifact
preservation, would weaken existing safeguards.

`EXEC_EXIT_UNVERIFIED` remains nonretryable even when process-group cleanup was
confirmed. A timeout with an observed exit is `EXEC_INTERRUPTED`, also
nonretryable: repeated identical full-budget timeouts require operator review
rather than automatically consuming more validation budget. Durable admission
records a nonretryable outcome; identical automatic executions remain blocked
after restart. Lifecycle ownership, cancellation, cooldown, concurrency and retry
budgets are unchanged. No infrastructure-only agent correction or automatic
retry is added.

For failed/unverified cleanup, reconcile the owned execution through a supported
provider mechanism before requesting validation-only Resume. Preserve the failed
attempt/output and workspace artifacts. Review real failing assertions separately;
cleanup alone never authorizes approval. If the provider cannot verify termination,
leave the pod parked. Do not use Resume or retry authorization as a substitute for
termination reconciliation. An automatic path needs durable validation process
ownership, verified termination/recreation with artifact preservation, bounded
retry admission and retained attempt history.

## Timeout configuration

Repository setup `testTimeout` is in **seconds**; validation inputs convert it to
**milliseconds** (`* 1000`). The engine fallback is 600,000 ms (ten minutes).
Elapsed time near that bound suggests a timeout but does not prove historical
process termination or establish a suitable larger budget. Partial failing output
remains a failure regardless of later successful measurements.

Choose future setup budgets from healthy full-suite wall-clock measurements on
the same allocation. A budget change for a repository setup affects new launches,
not an existing task's frozen configuration or historical evidence. Do not inflate
a deadline to turn a failed check green. Existing tasks require the separately
audited finite one-shot budget selection described below, after settlement and
before normal retry admission. A selection grants no retry or recovery permission.

Desktop Swift checks require a Mac and separate verification. Linux tests cover
daemon contracts, real process-group termination scripts and durable nonretryable
admission; those tests do not certify historical executions.

## Recovery implementation and current provider limit

Immutable validation dispatch/outcome/result/resource evidence supports
authenticated inspection and retained-report access, plus a separate audited
finite one-shot test budget. Preservation of a mutable workspace cannot prove
final source/report content while its original execution remains unknown. The
current provider has no qualified final-content freeze or retrospective ordinary
validation process binding. Destructive reconciliation therefore returns
`VALIDATION_FINAL_CONTENT_UNVERIFIED` before resume/export/delete; neither a
stopped resource nor an older host snapshot is a bypass. No historical settlement
or recovery is claimed.

See [validation execution recovery](validation-execution-recovery.md) for exact
inspection, evidence, budget and separate retry controls, plus legacy limits.
