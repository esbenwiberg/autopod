# Human finalization of retained PR tasks

`GET /pods/:podId/retained-finalization` is a read-only, human-authenticated preview.
`POST` accepts only the shared `RetainedFinalizationRequest`: `requestKey`,
`expectedGeneration`, `expectedBinding`, `mode`, and a meaningful `reason` (10–4000
characters). No client-supplied PR URL, source proof, validation waiver, or actor is
accepted. This operation is not exposed through worker MCP.

The request binds the exact lifecycle, current resource/source pointers, frozen
execution settings, validation evidence and continuation/rewrite ownership. The
record additionally retains task identity, owner IDs, source locations, current and
original container identities, and the provider resource namespace. Changed
bindings, conflicting request keys/bodies/actors and unsupported ownership fail
closed. Native Goals, interactive workspaces, non-PR tasks, sidecars, pending
human decisions and active/unsettled worker, validation, recovery or delivery
requests are excluded. Historical unknown execution is **not** waived.

## Modes

- **`stop-retain`**: logical cancellation, not successful delivery. Stop only the
  exact current container if running; require observed stopped/deleted before
  `killing → killed`. No container deletion, network cleanup, worktree deletion,
  resource-pointer clearing, budget reset or accounting/result rewrite occurs.
- **`complete-merged`**: freshly read the recorded `pod.prUrl` using the task's
  authenticated provider. Require the frozen repository, branch and base target,
  clean retained source, and exact merged head or provider-proven ancestry
  including that source. Inspect source again across provider awaits. Repeat the
  proof after confirmed stop before committing completion. No push, merge,
  restart or source update is sent. Factual delivery evidence lives in the
  finalization ledger, separate from old validation/review results. Additional
  merged commits are not claimed as validated. Legal existing state transitions
  occur inside one transaction; intermediate approved/validated states do not
  create validation results or human approval records.

The initial supported quiescent statuses are `failed`, `review_required`, and
`validated`. A rewrite with unresolved preparation, an active merge state, or an
unsettled provider request remains blocked rather than being inferred complete.
An independently prepared but unselected repair remains retained; finalization
proves only the **immutable current owner-selected** source, not every preserved
candidate. Generation, branch and worktree must match the owner phase: original
binding before activation, selected/prepared source after activation. PR518 repair
ownership must match the original rewrite evidence, task and lifecycle; activated
repairs use their selected source, never the old rewrite original. An unselected
repair leaves the original rewrite candidate authoritative. Inconsistent or
unsupported repair chains fail closed.

A clean checkout alone is not authority. The observed HEAD must equal the frozen
anchor or be a verified, single-parent, same-tree Autopod checkpoint lineage in
this pod's quarantine namespace. Recorded checked checkpoints must still be
included. Both anchor and observed HEAD/lineage are retained in delivery evidence.
Provider proof includes the immutable anchor; owned no-op capture commits need
not themselves have been published. An unrelated same-tree commit, foreign
checkpoint, or clean replacement B cannot substitute for selected A. A legacy
original binding without a tree resolves the tree from its exact recorded Git
commit, not from the currently observed HEAD.

## Pending is not terminal

The durable intent and all resource claims are committed before any stop request.
A separate durable dispatch marker is committed before calling stop. After that
marker, a retry/restart never sends stop again, even when the process died between
recording the marker and sending the request. It only reads the exact provider
resource identity/status. Unknown, running, unavailable or mismatched resources
remain pending/fail closed. This deliberate conservative window may require
manual provider-side reconciliation; there is no automatic redispatch escape.

POST returns the receipt directly: HTTP 202 for `state: pending`, HTTP 200 for
`state: finalized`. Keep the **exact original request** and retry it explicitly;
do not replace its key, binding, reason, or mode after an uncertain response.
GET never progresses the operation. A failed initial proof creates no intent.
Once admitted, proof failures or drift preserve the fence and all resources.
Terminal state, finalized receipt, and the actual terminal `pod.status_changed`
and `pod.completed` events commit in one transaction. Broadcast happens only after
commit, using the existing event bus listener isolation; persisted events remain
replayable if the process dies before broadcast. No intermediate validation or
approval event is invented. Same-key concurrent calls coalesce; completed retries
return the saved receipt without duplicate events or external calls. Completion
subscribers receive the real outcome, but this operation deliberately does not
invoke dependent-worker dispatch or the legacy cleanup/readiness completion path.

Pending **and finalized** operations fence mutating pod controls, source/task
admission, restart reconciliation, deletion and resource transports. Container
claim sets protect the current replacement as well as all recorded historical
owner/dispatch resources and source/report locations, without a latest-owner or
history-page limit, even if a mutable pod pointer is lost. A current container
claimed by another task is a refusal, not permission to stop shared execution.
Where the original checkpoint/repair records a resource namespace, it must match
the currently observed provider key before an intent can be admitted. Terminal/orphan reapers retain
these claims. Host cleanup also checks retained worktree/archive locations,
ancestors, and discovered common Git storage before removal, including the
otherwise-destructive orphan-branch conflict fallback. Repository-wide pruning
checks both common Git storage and every registered worktree path, including
paths already unavailable at admission. A custody refusal skips pruning without
entering a deletion fallback. Daemon Git commands also disable automatic
worktree-metadata pruning during GC; object repacking remains available. This
protects daemon-controlled operations, not external filesystem deletion or
operator-run Git commands. There is intentionally no release/delete operation;
retained sandboxes may continue to incur storage charges.

## CLI and desktop

`ap finalize-retained <pod>` performs inspection only; use `--json` to retain the
complete view and saved request. Submission requires `--apply`, exactly one of
`--stop-retain` or `--complete-merged`, and explicit `--request-key`, `--generation`,
`--binding`, and `--reason`. Save these values. An uncertain submission is never
automatically retried, including after authentication failure. Reconciliation
uses the exact original values, not a fresh preview's binding. The CLI rejects
uncorrelated or unsupported receipts instead of inferring a terminal outcome.

The desktop card separates the two confirmation-gated actions. Its private,
connection/pod-scoped journal persists the request before submission. Lost
responses and app/sheet closure retain that request for explicit reconciliation.
Pending responses do not optimistically complete or kill the pod. A rejected
draft can be discarded only after fresh inspection proves its server intent is
absent; another sheet cannot overwrite an uncertain request.

## Integration and qualification

Migration **241** introduces the operation/resource ledger, following the input
attachment migrations238–240 on main. PR518/migration237 is a prerequisite;
241 refuses a database missing its repair-binding column. Upgrade tests preserve
both historical pod evidence and attachment records through the current main schema.
The earlier local-only238 finalization migration was renumbered before publication;
it was never deployed. Deployment and live incident use require separate authorization.
Never downgrade to a binary unaware of retained-finalization custody.

Tests use real SQLite, including reopen and transaction-failure cases, with
mocked container/provider transports. They do not qualify live Docker/Azure
behavior or authorize applying this operation to a real incident.
