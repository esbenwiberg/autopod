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

## Desktop recovery controls

Pod detail now has one **Review recovery…** entry for the different recovery
flows. Choose **Recover files** for machine-only start, or **Free storage** to
review loss-accepting deletion; they no longer share a destructive checkbox.
Status inspection starts on appearance for idle supported pods, and failures
remain visible rather than hiding recovery. Saved sandbox start/deletion decisions
survive navigation and restart as separate exact requests. See
[Desktop recovery](desktop/recovery.md) for navigation and the distinction between
preservation, stopped execution and retained storage. The owning controls provide:

- **Check status**: fresh provider GETs and the original wakeup evidence. An exact
  Running observation can settle a wakeup. Inspection never sends a resume,
  launches an agent, runs checks or grants delivery authority.
- **Start environment for file recovery**: explicit human reason and exact resource /
  lifecycle binding. This only wakes the existing machine. It does not change pod
  status, inject coding credentials, continue an agent, validate, push or reopen a
  PR. Worker/validation/source/delivery/Goal custody remains independently gated.
  An unresolved resume, legacy missing baseline or unknown provider readiness
  does **not** become safe merely because a human clicked Start. No force-start
  or provider-idempotency guarantee is invented. A dispatched start request ID
  never dispatches another start on replay, including after daemon restart.
- **Discard unsaved data and delete…** (abandonment): explicit reason, data-loss acknowledgement and a second
  destructive confirmation. The authenticated actor, original intent IDs, exact
  provider namespace and pod selection are durably retained before DELETE. This
  authorizes loss of unpreserved files/reports, not a fabricated rejection or
  worker exit. Unknown readiness does not prevent an explicitly authorized
  DELETE. An idle sandbox held only by an exact immutable validation dispatch can
  also be abandoned: the decision captures its dispatch IDs, resource/configuration
  bindings, and immutable result/outcome/publication hashes before deletion. This
  deliberately discards unpreserved final source/reports; it does not claim to
  reconcile the execution or preserve its final content. Active task invocations,
  worker/validation admissions, other task/resource owners, Goal, checkpoint,
  source-adoption and delivery custody still block abandonment. Historical
  validation without immutable ownership cannot be inferred from a container
  pointer. Start and ordinary Delete retain their existing validation fences. Actual provider deletion
  must be confirmed by GET 404 before this wakeup hold releases. Ordinary Kill,
  reapers and Delete do not inherit a pending abandonment's authority.

If a response is lost, use Check status and **Continue the recorded deletion…** on the
same request. DELETE continuation targets the same exact resource; no replacement
sandbox or new execution is created. If the selected pod changed, a fresh explicit
confirmation is required. A different human records their own decision rather
than impersonating the original actor. Confirmed deletion reconciles outstanding
abandonment decisions for that exact resource, but never authorizes deleting a
replacement pod. If normal pod cleanup still has another hold or fails, the sheet
reports **sandbox deleted; pod cleanup blocked**, retains its receipt, and does
not remove the pod locally.

Abandonment receipts and original wakeup evidence survive pod deletion. Original
wakeup intents are **not** marked rejected, expired or observed-running by
abandonment. The separately recorded deletion proof releases only the selected
original intents. Do not roll back to a binary that ignores pending recovery
ownership or manually clear either journal. Native Goal and retained-checkpoint
custody require their own recovery; these controls cannot override them.

Starting a sandbox is not task continuation. Existing Continue/Goal/repair
controls retain their normal source, budget and execution checks. The file and
evidence views remain separate from this physical-resource control. No interactive
shell, agent or terminal is automatically opened.

The sheet warns that stopped sandboxes may still incur storage charges. Deleting
one sandbox does not prove cleanup of independent snapshots, images or volumes.
Older daemons show an unavailable message rather than a fake working control.
Connection changes invalidate pending client results and decisions.

### API contract

Authenticated human `GET /pods/:podId/sandbox-recovery` returns fresh observations,
per-action blocking reasons, generation, current user, wakeup evidence and durable
recovery decisions. It does not cache provider observations as readiness authority.

Authenticated human `POST /pods/:podId/sandbox-recovery` accepts only:

```json
{
  "id": "stable-human-decision-id",
  "action": "abandon",
  "sandboxId": "exact-original-id",
  "expectedGeneration": 1,
  "expectedResourceKey": "exact-provider-resource-key-from-inspection",
  "reason": "Explicitly discard retained unpreserved files and reports",
  "acknowledgeDataLoss": true
}
```

`action` is `start` or `abandon`; reason is 10–4000 trimmed characters. Start does
not require data-loss acknowledgement. The response includes `operation`,
`podDeleted`, and `cleanupError`. The request ID is bound to its full payload and
authenticated actor. Replays with different content/actor, caller-supplied proof,
force flags, source substitution and unknown fields are rejected. Migration 228
adds immutable decision identities and append-only events. Migration 231 adds an
immutable `validationEvidence` selection to the decision; existing requests default
to no validation authority and cannot be silently upgraded. No existing wakeup or
validation history is rewritten. Validation destruction authority exists only
inside the exact provider DELETE and post-confirmed-deletion cleanup callbacks;
it is rechecked after awaits, expires when each callback returns, and never grants
Start, retry, validation, worker or delivery permission. The original validation
failure and unknown execution remain in retained audit history after pod deletion.

## Existing blocked resources

Authenticated `GET /pods/:podId/sandbox-wakeup` is a read-only journal view with
at most 50 intents and the last 20 evidence entries per intent. New evidence
includes HTTP status, allowlisted provider correlation/backoff headers and static
transport error codes, never bearer tokens or raw response bodies. Old pending
intents retain their original identity and have no backfilled response evidence.
This endpoint neither contacts Azure nor grants settlement or replay authority.
The intent ID is the original `x-ms-client-request-id` for provider investigation.

This protocol does not prove the disposition of a previously lost restore
response. Outside the explicitly confirmed abandonment path, keep original
resources, snapshots, exclusive operation records and unknown usage intact. Obtain fresh provider evidence and diagnose the original
operation; do not clone, delete, fabricate a rejection/exit, grant new execution
or relabel old-source validation. Current-source handoff and verified report
capture remain separate work. The explicit abandonment path above permits deliberate
loss, not an assertion that those captures succeeded.
