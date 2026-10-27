# Validation timeout evidence and recovery

A validation timeout is an interruption, not an observed test exit. The Azure
streaming client now retains its explicit timeout cause, configured budget in
milliseconds, partial output and measured validation duration. An unexpected
WebSocket close does not become a timeout merely because it happened near the
budget. Missing or invalid exit frames never establish successful execution.

On timeout, the ordinary streaming wrapper's owned process group receives TERM,
with up to two seconds to exit, then KILL if necessary, with up to two seconds
for confirmation. Cleanup checks the recorded leader's process start time and
group before signalling; a missing/stale receipt fails closed. The cleanup API
request has a five-second timeout and makes a single attempt (no normal
rate-limit backoff). It can be rejected by providers that prohibit concurrent
buffered exec beside streaming exec. Validation waits for cleanup to settle.

`infrastructureFailure.execution` records `cause`, `timeoutMs` (when known), and
`cleanup` (`confirmed`, `failed`, or `unverified`). An `observedExitCode` is retained only when an actual exit frame or supervisor
receipt arrives, including during cleanup. Output received during the grace
period is retained too. These fields are optional for old records. Confirmed process-group cleanup does **not** invent an exit code or
establish that tests passed. Prior failing assertions remain in partial output;
the incomplete test status is not evidence that tests never ran. Desktop shows
the timeout budget, cleanup result and recovery guidance. Cleanup-pending or
retry-pending states are not presented without durable evidence.

## Supported recovery boundary

Ordinary validation execs do not have the durable, root-owned supervisor receipt
used by recorded native Goal processes. Suspending/stopping an Azure sandbox is
not proof that its processes exited. Reusing Goal recovery without durable
validation ownership, or deleting the workspace container before artifact
preservation, would weaken existing safeguards.

Accordingly, `EXEC_EXIT_UNVERIFIED` remains nonretryable even when process-group
cleanup was confirmed. A timeout with an observed exit is `EXEC_INTERRUPTED`,
also nonretryable: repeated identical full-budget timeouts require operator
review rather than automatically consuming more validation budget. Existing durable admission records a nonretryable outcome;
identical automatic executions remain blocked after restart. Existing lifecycle
ownership, cancellation, cooldown, concurrency and retry budgets are unchanged.
No infrastructure-only agent correction or automatic retry is added. The
operator explicitly selected this supported fail-closed scope for
key-chimpanzee instead of adding a new supervised validation subsystem.

For failed/unverified cleanup, reconcile the owned execution through a supported
provider mechanism before requesting validation-only Resume. Preserve the failed
attempt/output and workspace artifacts. Review real failing assertions separately;
cleanup alone never authorizes approval. If the provider cannot verify termination,
leave the pod parked and escalate to the operator; Resume is not a termination
bypass. A future automatic path needs durable validation process ownership,
verified termination/recreation with artifact preservation, bounded retry admission
and retained attempt history.

## Timeout configuration

Repository setup `testTimeout` is in **seconds**; validation inputs convert it to
**milliseconds** (`* 1000`). The engine fallback is 600,000 ms (ten minutes).
The supplied professional-mammal observation was 600,751 ms at a configured
600 seconds, with real failing test output before transport loss. That evidence
suggests a timeout but does not prove historical process termination or establish
a suitable larger budget. This PR changes no defaults, frozen pod configuration,
production setup, schedules, or professional-mammal state.

An operator considering a setup budget change should first collect complete suite
wall-clock distributions on the same sandbox tier, investigate the observed test
failures and compare healthy upper-percentile runtime with 600 seconds. Choose a
finite budget with measured headroom, then update setup for future launches
through normal configuration procedures. No specific increase is justified by a
single incomplete run.

Desktop Swift checks require a Mac and must be verified there; Linux tests cover
the daemon contracts, real process-group termination scripts and durable
nonretryable admission.
