# Retained agent continuation

A saved human answer is not proof that a worker received it, and a retained
container ID is not proof that the container is running.

## Preparation order

Detached human replies and task-feedback continuations use the original bound
resource. Before building resume environment variables, reading rotated auth,
writing registry credentials, probing the CLI or configuring a runtime:

1. Check the current lifecycle, container, provider/model binding, source location
   and unanswered decisions. Unverified task execution still blocks continuation.
2. Observe the original container status. A running resource needs no wakeup;
   a stopped resource gets a wakeup operation; deleted or unknown resources fail
   closed without spawning a replacement worker.
3. Recheck ownership after each awaited observation or wakeup. Observe Running
   before preparing credentials. A superseded continuation must not fail or
   configure the lifecycle that replaced it.
4. Keep the existing execution-provenance and runtime-priming checks before
   dispatch. Native Goal controls and retry/budget admission are unchanged.

This applies to ordinary auto-suspended sandboxes, not only resources marked for
recovery after a daemon restart. A wakeup failure retains the original resource
and dispatches no new worker.

## Human reply custody

Normal replies are recorded in the escalation history and queued for
`check_messages` in the same durable transaction, before wakeup or dispatch.
The worker must acknowledge delivery through the existing message protocol.
A credential-write failure, lost resume response or daemon restart must not turn
a recorded human answer into an implicitly consumed answer. Detached MCP
fallbacks retain the same text and are queued once, not twice.

## Current readiness and automatic retention

An explicitly cleared current validation result is unknown; a historical pass
must not silently replace it. Cached ready snapshots are projected against the
current lifecycle and proof on detail/list reads without rewriting historical
approval. Code delivery, current-source validation, runtime recovery and report
preservation remain separate.

Automatic terminal reaping no longer wakes, checkpoints or deletes failed
sandboxes. Git checkpoints do not establish preservation of ignored reports.
Completed/killed resources also remain held while task runs or validation exits
are unsettled. Orphan detection includes unresolved dispatch-bound resources
even after the current pod's container pointer is cleared, retains possible
sources labelled for failed/review-required owners, and rechecks claims before
each deletion. A label only justifies retention, never source adoption or proof
of backend termination. Existing exact-source external-delivery holds still
apply. This can retain billable storage indefinitely; it is not a report archive
or an automatic cleanup permission.

## Durable wakeup custody

The Azure adapter uses the SQLite journal described in
[`sandbox-wakeup-recovery.md`](sandbox-wakeup-recovery.md). Potentially dispatched
resumes survive restart and cannot be blindly reposted. Revoking an unsent
claim cannot revoke an admitted transport. Caller ownership checks propagate
through provider/auth awaits. Legacy stopped resources without a Running
baseline fail closed; this deliberately does not turn old uncertain restores
into retry permission.

Inline failed-worker checkpointing no longer deletes the original sandbox.
Stopped, active/unsettled or unverified-validation resources are not restored
for that background collection. Pending wakeup claims also fence explicit
cleanup/Kill/Delete and backend deletion; current-pointer loss does not release
the resource, and a recorded owner label retains its host source too.

## Scope and remaining work

The sequencing/custody fix does not itself establish that an outcome-unknown
provider resume was accepted, terminate an old execution, adopt a newer remote
source revision, or recover inaccessible reports. It does not authorize a retry,
reset task-wide accounting, waive validation, or complete a pod whose delivery is
unresolved. Provider diagnosis for pre-journal uncertain restores, reviewed legacy recovery
controls and verified capture/release of report-retention holds remain separate
recovery concerns. No provider timeout is treated as termination or as permission
to blindly repeat its mutation.
