# Discard an idle sandbox approval rewrite

`ap abandon-rewrite` permanently discards one idle failed/review-held sandbox
approval rewrite, its original and candidate sandboxes and host worktrees, then
removes its pod from the fleet. This is **not Archive**, repair, validation
settlement, a retry grant, approval, publication or merge. Unpreserved files and
reports are lost. Immutable rewrite, execution, accounting and deletion receipts
remain in history after the live pod row is removed. An existing PR is unchanged.

## Inspect, then explicitly select

Use a daemon and CLI release containing this protocol. There is no fallback to
ordinary kill/delete, direct Azure deletion or editing custody records.

```sh
ap abandon-rewrite "$POD_ID" --json
```

Review the returned generation, binding and complete resource/worktree snapshot.
Then supply that exact selection, a stable request ID, your reason and explicit
loss acceptance:

```sh
ap abandon-rewrite "$POD_ID" --apply \
  --request-id "$REQUEST_ID" --generation "$GENERATION" --binding "$BINDING" \
  --reason 'Discard this task and its unpreserved source and reports' \
  --acknowledge-data-loss --json
```

Save the request and receipt. Inspect is read-only and does not wake a sandbox.
Apply does not silently refresh the selection. A stale binding, missing consent,
nonhuman caller or conflicting request key fails before deletion. After admission,
source/execution/delivery and foreign resource claims are durably fenced.

The protocol currently supports a single activated, unrepaired sandbox rewrite in
`failed` or `review_required`, with no active work, unresolved merge/publication,
Goal, pending human decision, sidecars, test resources or independent recovery
custody. It binds the exact current unverified validation dispatch when available;
unknown historical/foreign executions or provider namespaces remain blocked.
A stopped sandbox alone never proves termination or safe recovery.

## Outcomes and reconciliation

Each sandbox DELETE is dispatched at most once. A returned error or lost response
is **not** evidence of deletion. Reuse the identical request to observe/reconcile;
a second DELETE is not blindly dispatched. If the provider has not confirmed the
resource absent, the task stays held. Investigate that operation rather than
changing request keys, claiming settlement or waking/restarting work.

Confirmed resource deletions have durable receipts. Only after every selected
sandbox is absent can host cleanup and the existing owned pod deletion proceed.
Settled cleanup failures can resume under the same exact request; an unresolved
cleanup attempt remains protected by its existing deletion-ownership rules.
`podDeleted: true` means the actual fleet row was removed after confirmed resource
cleanup, not merely hidden. Exact successful replay returns the saved outcome,
even after removal, without further deletion. No receipt claims checks passed or
that unknown execution was previously settled.

The authenticated human API is `GET/POST
/pods/:podId/approval-rewrite-abandonment`. POST accepts only `id`,
`expectedGeneration`, `expectedBinding`, `reason`, `acknowledgeDataLoss: true`.
Identity comes from authentication; force, actor, path and provider-proof fields
are rejected. Both methods use `Cache-Control: no-store`.

This release adds append-only schema 270 decisions/receipts and durable source and
resource reservations. Do not downgrade to a binary unaware of these reservations.
Unit/integration tests use real SQLite and Git fixtures with mocked provider
observations; they do not prove live Azure deletion. Verify the live daemon SHA,
backup, exact admitted snapshot and final provider/pod outcome separately.
