# Recover a known checkpoint without claiming the old execution settled

This is a **source selection**, not execution reconciliation. It addresses legacy
sandbox validations with no immutable dispatch binding, and approvals blocked by
an outcome-unknown resume. Ordinary recovery remains preferable when it applies.

A stopped sandbox may contain suspended processes. Its Git checkpoint does not
prove the final mutable source or custody of ignored reports. This workflow never
wakes, executes in, clones a memory snapshot of, stops, or deletes that original.
The human explicitly chooses an exact clean **host Git commit**, accepting that it
may omit unsynced sandbox edits. The original remains available as retained
evidence, not as an execution resource.

## What selection authorizes

1. Record the authenticated human, stable request ID, exact original generation,
   validation-result hash, checkpoint commit, configuration hash and provider
   namespace. Revoke old pod-scoped credentials through a durable signed epoch.
2. Preserve host bytes (including ignored reports and symlinks) with an inventory
   receipt; create a Git bundle and independent bare repository/worktree. Preserve
   remote-tracking base refs too. Neither refs nor objects are shared with the
   original; no network fetch or branch publication occurs. Only the private clone
   ignores untracked daemon-generated `.autopod/evidence/` and `.autopod/screenshots/`
   outputs. These bytes still require report custody; tracked edits and unrelated
   untracked source remain visible. The original Git excludes and committed
   `.gitignore` are never changed.
3. Advance the same pod to a new generation, using only that independent source.
   Keep its task identity, retry history/counters, contract, options, base branch
   and execution settings. Clear old *current* validation/review projections only
   after retaining them in the immutable recovery record. Disable autoapproval.
4. Provision fresh infrastructure through the normal queue, then run genuine
   checks and configured review. No coding worker is admitted by this operation.
   Recheck exact source and configuration before accepting its outcome. Source
   edits, missing worktrees, unknown execution outcomes and failed preservation
   fail closed; the daemon must not substitute a fresh remote checkout.
5. On a pass, preserve the new sandbox reports **before suspension**. No PR push,
   creation, dependent launch, approval or merge is performed. A later, separate
   approval can reuse only the exact generation/resource/result/source-bound
   report receipt after verifying its inventory, avoiding another cold wake just
   to read those reports.

Original resource holds survive changed pod pointers, completion, restart and
orphan reaping. Original wakeup intents and failed results remain unchanged.
Task-wide operations are fenced during preparation/checking, and deletion of a
pod with retained originals is refused. This release provides no destructive
release of that evidence. Do not downgrade to a daemon that predates these holds
and credential epochs after making a selection; an old daemon cannot enforce
these custody rules.

## Operator procedure

Use the maintained CLI against the intended daemon. Inspect first:

```sh
ap status <full-pod-id> --json
ap reconcile-validation <full-pod-id> --json
ap retry-state <full-pod-id> --stage validation --json
ap retry-state <full-pod-id> --stage worker --json
ap checkpoint-recovery <full-pod-id> --json
```

Independently inspect the retained host Git HEAD, clean source, intended base
branch, original resource namespace/status and the exact stored result hash.
Selection is limited to idle ordinary sandbox pods with an existing result and
retained host source, no unresolved worker/immutable validation execution,
competing source custody, Goal, waivers, sidecars or pending human decision.
A valid existing immutable validation dispatch requires its own recovery; this
legacy path must not detach it.

**Retry permission is separate.** A selection does not create a retry grant or
reset any allowance. If the prior validation failed nonretryably and changed
conditions are not established, an authorized human must first record a specific
one-shot validation retry using `ap authorize-retry`. That metadata permission
alone never settles or executes the original. Do not grant a worker retry for
this checks-only operation. A provider-binding change is still refused.

After explicit authorization of the selected source and fresh infrastructure:

```sh
ap checkpoint-recovery <full-pod-id> --apply \
  --request-id <stable-request-id> \
  --generation <original-generation> \
  --result-hash <sha256-of-exact-stored-validation-result> \
  --head <exact-host-checkpoint-commit> \
  --reason 'Choose this saved checkpoint for fresh checks; retain unknown original source and reports' \
  --json
```

HTTP equivalents are authenticated-human `GET` and `POST`
`/pods/:podId/checkpoint-recovery`. POST accepts only `id`, `expectedGeneration`,
`expectedResultHash`, `checkpointHead` and `reason`. It returns `202` with the
recorded selection, not successful checks. There is no caller-supplied proof,
source path, settlement, force flag or alternate actor.

Observe `ap checkpoint-recovery`, pod status and activity until an actual outcome
is recorded. `prepared`, `activated`, `checking`, `checked` and `blocked` events
are durable and append-only. A `checked` record can contain a failing result:
verify the outcome, current status, configured review and report custody, not
merely the presence of a receipt. Acceptance requires actual pod progression;
a healthy deployment or accepted selection is not recovery success.

Reuse the **same request ID** after a lost response. A replay observes the existing
record; it does not repeat preparation, advance another generation or reissue
provider calls. Concurrent queue callbacks coalesce in-process. An interrupted
`checking` invocation is not automatically replayed after restart. A blocked or
interrupted operation requires inspection of retained execution evidence and
server logs correlated by recovery ID; do not clear rows, mutate the original,
choose a new ID to force another run, or infer success from `Stopped`.

## The two motivating incidents

- `chilly-dog`: preserved commit
  `8f90da6592ff98c331b486636c35b78034691c76`, intended base
  **`ewi/azure-pod-desk`**, not `main`. Its old `EXEC_EXIT_UNVERIFIED` remains
  unverified; new checks apply only to the explicitly selected source.
- `evolutionary-tuna`: preserved commit
  `2fbb347f1a8ea9abe47faf4f3274730c1e42dad9`, also PR #474's inspected head.
  Resume `b9d28ff8-c60e-4347-8dc4-124da5fe4521` remains unresolved. A replacement
  resource must not replay that request. PR #474's migration 225 independently
  conflicts with main and must be renumbered above the **fresh** migration maximum
  and revalidated before any merge. A checkpoint pass does not fix that collision
  or authorize publication/merge.

These are investigated checkpoints, not automatically executed recovery
requests. Refresh all live identities before acting. Original sandbox content
may be newer than either checkpoint; retain it and disclose the selection.

Related contracts: [validation execution recovery](validation-execution-recovery.md),
[sandbox wakeups](sandbox-wakeup-recovery.md),
[approval report custody](sandbox-approval-recovery.md), and
[retained continuation](retained-continuation-recovery.md).
