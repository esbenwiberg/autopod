# Operator Kill and Delete

An authenticated operator can request either action for an **exact existing pod ID**
in any lifecycle state, including archived pods and held validation/recovery.
Kill requests execution stop and retains files. Delete additionally requests permanent
discard of that pod's unpublished resources and requires explicit data-loss consent.
Neither action rewrites validation, review, delivery, historical outcomes or external refs.

```sh
ap kill exact-full-pod-id --request-key operator-decision-1
ap delete exact-full-pod-id --acknowledge-data-loss --request-key operator-decision-2
ap disposal exact-full-pod-id
ap disposal exact-full-pod-id --observe
```

The daemon commits actor, exact pod/generation, intent, scope, subject and idempotency
before effects. Acceptance clears Active/Needs attention and is shown separately in
History/Recovery. New execution, retries, publication and dependent release are fenced
across restart. The original pod, its failure/validation results and diagnostics remain
readable. Fleet archive is still visibility only and is not a disposal receipt.

`POST /pods/:podId/operator-disposal` takes `requestKey`, `expectedGeneration`,
`intent` (`kill` or `delete`) and, for Delete, `acknowledgeDataLoss: true`.
It returns **202** with the distinct `operator-disposal-v1` contract. The old Kill
and Delete endpoints retain their existing contracts; new clients use this additive
endpoint and never fall back to old destructive actions when it is unsupported.

`cleanup_pending` means acceptance only, including refused ownership, unsupported
backends/topology, partial removal and unknown stop outcomes. It must never be rendered
as killed/deleted. `stopped` means independent physical observation confirmed the
recorded owned execution stopped; files remain. `discarded` means exact supported
execution/network/worktree targets were independently observed absent. PRs, branches,
shared Git stores and durable history are retained. Delete is an explicit later upgrade
from Kill, with its own key and data-loss acknowledgement.

Keep the printed request key. After a lost reply, read the receipt before submitting
anything else; an identical request/actor/key is idempotent. `--observe` reconciles saved
targets and dispatches. It never repeats an uncertain stop/removal. Already admitted
publication/merge or other external effects cannot be undone or promised prevented:
their owning ledgers require reconciliation, without replay or inferred approval.

Physical cleanup currently uses the existing exact local Docker Engine/topology and
reciprocal physical Git worktree proofs. Foreign/shared claims, incomplete allocation
history, additional linkage/recovery resources and unsupported Sandbox cleanup remain
pending. Missing pod resource fields are not proof of absence. An earlier worker Docker
ID is accounted for even if validation-only retry reused the same task/worktree and
generation with a replacement container. The `favourite-salmon` and `statutory-tortoise`
fixtures retain generation-1 `EXEC_EXIT_UNVERIFIED` outcomes with no immutable original
validation dispatch; an absent predecessor without positive closure proof keeps cleanup
pending instead of bypassing the historical-ID guard that rejected #715.

Desktop cards and detail overview expose Kill and a Delete confirmation in every state.
History/Recovery shows receipt state and diagnostics independently of the old lifecycle.
Native desktop verification must run on macOS using `./scripts/test-desktop.sh` and
`swift build --package-path packages/desktop`; Linux checks do not establish native UI correctness.
