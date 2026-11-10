# Desktop recovery

Pod detail has one **Recovery options / Review recovery…** entry instead of
separate sandbox, environment replacement, stalled execution and finalization
banners. Supported running tasks keep a quiet discovery entry; a failed task,
recorded pending decision or retained environment gets a contextual card.

## Understand before acting

The overview separates:

- **What happened:** the task's recorded outcome, with its failure details available.
- **Saved work:** preservation recorded versus not verified. A Git checkpoint is
  never described as proof that final files and reports are all saved.
- **Execution:** worker-stop evidence versus an unverified outcome. Machine state
  alone does not prove execution termination or failure of an earlier request.
- **Storage:** retained sandbox resources and possible ongoing storage charges.
  This is not an inventory of every independent image, volume or snapshot.

Status comes from existing owning recovery observations, not frontend error-code
parsing or inferred timeouts. Observations from different lifecycle generations
require another status check before new workflow navigation. Every mutation
still refreshes/rechecks its own exact source, resource and request bindings;
the overview does not grant permission. Preservation/worker-stop flags are used
only when their own checkpoint-context generation matches the repair inspection;
missing identity stays unverified. Status changes keep the recovery window and
its recorded outcome visible rather than creating a new controller.

## Choose an outcome

### Continue work

Review separate controls for checks-only retries or validation repair, qualified
environment replacement, supported Docker stalled-run stop/preservation, or
ending with work retained / verifying an already-merged PR. Opening a control
is not execution authorization. Budget, retry, source custody, pending guidance
and independent-check requirements still apply.

The replacement view explains source selection, settings preview, actual
qualification, coding and checks separately. It does not publish or merge.
This first UI slice still requires an independently inspected full host commit
and reviewed replacement profile ID: the existing inspection protocol does not
discover a safe source automatically. Do not paste a guessed or historical SHA.
Source cards and profile discovery require a separate correlated selection
contract, not a client-invented default.

### Recover files

See saved files/evidence where available, or explicitly start the original
sandbox for file recovery if its policy permits it. This does not continue the
coding agent, run checks, inject new coding authority or publish changes.
A saved evidence view is not proof of the original environment's final contents.
No destructive checkbox or delete button appears in this path.

### Free storage

Review exact retained resource identity, blockers, a reason, explicit acceptance
of unsaved file/report loss and a second destructive confirmation. The supported
operation is **Discard unsaved data and delete…**, not archive-and-release. It
also attempts pod deletion; a confirmed environment deletion with blocked pod
cleanup remains a distinct partial result. Stop-and-retain does not free storage.

An unknown sandbox start can still have a separately reviewed loss-accepting
delete path when the owning backend allows it. Other task, source and execution
owners remain blockers. No unknown execution is called settled or preserved.

## Pending decisions and uncertain outcomes

The overview surfaces saved/unresolved decisions before suggesting new work.
Check status observes rather than resubmitting a mutation. Continue abandonment
uses the exact original request. A start request is never blindly replayed.
Sandbox start and abandonment have separate protected request journals scoped
to the owning connection/pod. Deletion decisions are additionally keyed to the
observed generation and exact resource. A changed selection requires a new
reason, loss acknowledgement and confirmation; older immutable decisions remain
retained rather than being overwritten or retried against the new selection.
A definite rejection is durably recorded separately from the immutable request,
bound to that exact request body. This survives restart, but still requires fresh
evidence of absence before the UI can explicitly discard the rejected draft.
Unreadable or mismatched evidence fails closed.

Full hashes, generations, resource namespaces, operation IDs and audit history
remain available under technical disclosures. Connection changes invalidate
current observations and do not discard saved decisions. Inspectors that do not
apply to the new lifecycle no longer contribute stale generations to the overview;
their saved requests and outcomes remain available to their owning controls.

## Not implemented by this UI change

Verified archive-and-release, custody release for retained originals, resource
reaping policy changes, automatic retry grants/budget increases, and new delivery
or merge authority are not provided. The unified UI composes existing native
controllers and protocols; it does not introduce a generic execute-recovery API.

See [sandbox wakeup recovery](../sandbox-wakeup-recovery.md),
[retained continuation](../retained-pod-continuation.md), and
[validation recovery](../validation-recovery.md) for the owning policies.
