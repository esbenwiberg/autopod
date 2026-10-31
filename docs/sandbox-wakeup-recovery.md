# Retained sandbox wakeup custody

A timed-out resume POST may already have reached Azure. Stopped/Suspended/Idle
is not rejection, process termination, report preservation, or permission to
repeat that POST.

## Durable protocol

Migration 218 records immutable per-provider-resource Running baselines and
wakeup intents. The resource key includes the region endpoint, subscription,
resource group, sandbox group and sandbox ID. A baseline in one namespace cannot
authorize a resume in another. The production Azure factory receives the journal
from the daemon's SQLite-backed pod repository, independently of managed/native
worker accounting. Missing journal means no resume mutation.

1. Observe the exact resource. Running may finish an existing wakeup intent and
   establishes a baseline for a later stop episode. This is physical readiness,
   **not** worker/validation termination or source validation.
2. A stopped resource needs a journaled Running baseline before a new intent can
   be claimed. Pre-journal stopped resources fail with
   `SANDBOX_WAKEUP_LEGACY_UNVERIFIED`: an old outcome-unknown restore must not be
   silently treated as rejected. A first observation of Stopped does not create
   that missing evidence.
3. Commit one pending intent before requesting transport credentials. Other
   clients/daemon instances observe rather than submit another POST.
4. After credentials arrive, recheck lifecycle ownership, deadline and intent
   identity. Atomically mark dispatch started immediately before transport;
   use the intent ID as `x-ms-client-request-id` for provider investigation.
   This correlation ID is **not** an assumed provider idempotency guarantee.
5. The exact `409 ResourceLocked` response or explicit HTTP `429` establishes
   rejection and permits a later bounded admission after backoff and a fresh
   stopped-state observation. Migration 226 preserves old intents unchanged and
   adds append-only transport evidence; a `rate-limited` settlement requires a
   recorded 429, captured atomically with settlement. A lost response, timeout,
   unrelated conflict or server error does not release a dispatched intent.
   The initiating caller observes fresh GETs for Running without resubmitting.
   A later caller gets `SANDBOX_WAKEUP_RECONCILIATION_REQUIRED` immediately after
   observing a stopped resource with an existing intent. A fresh Running
   observation still settles that intent; elapsed time never does.
6. An unsent claim can be atomically revoked on local cancellation/timeout.
   Its delayed transport can no longer pass the dispatch CAS. A dispatched
   claim cannot be revoked this way, cannot expire by elapsed time, and survives
   a database reopen. Late observations after an aborted deadline cannot settle
   it. A process crash before dispatch may still leave an unsent intent requiring
   explicit investigation; it is not automatically treated as rejected.

Continuation ownership checks propagate into both Docker and Azure start
adapters, including after asynchronous provider/auth work and before dispatch.
A superseded owner cannot inject credentials or start a new coding worker.
Provider readiness never overrides Goal, execution, guidance, source or budget
fences.

## Preservation and deletion

Pending wakeups retain the original resource across current-pointer loss,
background reapers, central cleanup, Kill/Delete checks and Azure deletion.
These holds do not archive reports. Failed-worker inline preservation only
attempts tracked-source checkpointing for an observed-running resource with no
unsettled worker or validation execution; even a successful checkpoint no longer
justifies deleting the sandbox or its ignored reports.

Stored intent/settlement evidence is immutable. Retained resources can continue
to bill. Do not roll back to a binary that ignores these holds while pending
intents exist, and do not manually clear journal rows to make recovery proceed.

## Existing blocked resources

Authenticated `GET /pods/:podId/sandbox-wakeup` is a read-only journal view with
at most 50 intents and the last 20 evidence entries per intent. New evidence
includes HTTP status, allowlisted provider correlation/backoff headers and static
transport error codes, never bearer tokens or raw response bodies. Old pending
intents retain their original identity and have no backfilled response evidence.
This endpoint neither contacts Azure nor grants settlement or replay authority.
The intent ID is the original `x-ms-client-request-id` for provider investigation.

This protocol does not prove the disposition of a previously lost restore
response. Keep original resources, snapshots, exclusive operation records and
unknown usage intact. Obtain fresh provider evidence and diagnose the original
operation; do not clone, delete, fabricate a rejection/exit, grant new execution
or relabel old-source validation. Current-source handoff, verified report
capture and reviewed release/reconciliation controls remain separate work.
