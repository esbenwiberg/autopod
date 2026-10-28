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

## Scope and remaining work

The sequencing/custody fix does not itself establish that an outcome-unknown
provider resume was accepted, terminate an old execution, adopt a newer remote
source revision, or recover inaccessible reports. It does not authorize a retry,
reset task-wide accounting, waive validation, or complete a pod whose delivery is
unresolved. Durable wakeup observation and cleanup/report-retention rules are
separate recovery concerns; do not claim those are solved by this ordering fix.
