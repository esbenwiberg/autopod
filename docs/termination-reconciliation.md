# Recover a worker with unverified termination

A lost exec stream is not proof that a process exited. Autopod retains the failed
run's ownership and blocks another worker, validation, delivery and deletion in
that logical task. An empty current `containerId` or a saved checkpoint is not
process-exit evidence.

After deploying migration 216 and the matching daemon/CLI, an authenticated human
can reconcile a **failed sandbox worker** whose dispatch-recorded sandbox UUID is
now confirmed deleted by the daemon's configured backend:

```sh
ap reconcile-termination other-bonobo
# Inspect the exact run ID and owner pod. Inspection does not probe or mutate.
ap reconcile-termination other-bonobo --run RUN_UUID \
  --reason 'Recover interrupted worker after verified sandbox deletion'
```

`--run` and `--reason` are both required for apply. The API does not accept an actor,
resource ID, timestamp or deletion assertion from the caller. The daemon performs
a bounded fresh lookup using the run's immutable resource binding, checks the
failed lifecycle again after that lookup, and atomically appends an immutable
receipt and settles the run. Only `deleted` is accepted: a suspended/stopped
sandbox could run again. Running, unknown, errors, timeouts, legacy/missing
bindings, non-UUID resource names, replaced lifecycles/resources and native Goals
all fail closed. Use the same backend configuration that owns the recorded
sandbox; a status lookup against another sandbox group/endpoint is not evidence
about the original resource. Do not repoint the daemon to recover an old run.

If the pod still has a stale reference to that exact confirmed-deleted sandbox,
the same transaction clears it so Rework will not try to extract a nonexistent
resource. The historical dispatch binding and receipt retain its identity.
No sandbox is destroyed by this command. If one still exists, retain it and the
source; this command does not provide a destructive escape hatch. Native Goals
continue to use their existing process-specific recovery controls.

A receipt proves deletion observed at `observedAt`, **not** the original exit code,
successful completion or an exact execution duration. The original failed outcome,
failure category, output, source, retry accounting and usage remain unchanged.
The receipt is retained when the pod is later archived/deleted. Repeating a
successful request for the same run returns the original receipt, without another
backend lookup or another settlement. Reconciling a linked task through the wrong
pod names the actual retained owner; reconcile that owner explicitly.

## Continue implementation separately

Reconciliation does not start a worker, grant retry permission or change pod
status. Verify the preserved source before continuing, then inspect normal gates:

```sh
ap retry-state other-bonobo --stage worker
# Only if that state requires a human retry authorization:
ap authorize-retry other-bonobo --stage worker \
  --request-key recover-other-bonobo-worker-1 \
  --reason 'Reviewed preserved work; authorize continuation after transport loss'
ap rework other-bonobo
```

Use **Rework** to continue unfinished implementation from preserved source in a
new lifecycle. `ap resume` normally retries downstream validation/delivery without
running the coding agent; it is not a synonym for continuing unfinished code.
All ordinary budget, provider binding, unanswered decision, source integrity and
retry checks still apply. Do not clear ledger rows, fabricate exit codes, set pod
status directly or create a distinct task solely to evade unresolved ownership.

## API

- `GET /pods/:podId/termination-reconciliations`: task-wide pending ownership and
  retained receipts (default user authentication).
- `POST /pods/:podId/termination-reconciliations`: `{ "runId": "UUID", "reason":
  "10–4000 characters" }`; default user authentication, with actor from login.
  Returns the receipt, or 409 while proof/ownership remains unresolved. Worker
  HMAC pod tokens are not accepted. There is no MCP/action-engine entry point.
