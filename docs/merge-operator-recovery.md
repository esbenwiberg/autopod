# Operator recovery of an uncertain ADO merge

## GitHub approval gates and retained unknown requests

Pending checks, legacy commit statuses and non-clean/unknown GitHub merge gates
now defer to `merge_pending` before admitting a merge request. Polling waits for
fresh provider evidence; it never bypasses branch protection. A timeout or lost
reply after admission still has an unknown outcome and cannot be retried merely
because the PR remains open.

An unresolved admitted request or retained delivery failure is projected into
current Readiness Review, including older cached ready snapshots, without
rewriting validation or historical approval. Delivery-only warnings do not waive
validation or require a validation override; the source-bound recovery guard
still controls retries. Approval preserves `DELIVERY_RECONCILIATION_REQUIRED`
(409) for unknown-request/source/target reconciliation rather than wrapping it
as a generic 502. Original resources remain retained.

For an older GitHub request, inspect the exact PR/source/base and its actual CI
failures. Do not delete journal rows, force-complete the pod, or use the ADO-only
operator recovery command below. A normal human merge after the required gates
pass can be reconciled by approval when the provider proves the exact admitted
source/target and the retained source is still verifiable. A changed PR head is
not permission to reuse or overwrite the original admission. An open PR alone
is not a recovery receipt; otherwise leave it retained for explicit recovery.

## Approval rebase candidates and exact publication leases

Approval never rebases the approved checkout in place. If the fetched base is
already included, normal approval continues. Otherwise the daemon preserves the
original host source, prepares an independent Git checkout, and records an
append-only `approval_source_rewrites` binding before preparing the candidate.
The binding pins the confirmed predecessor publication and remote SHA, exact
base, original resource, candidate source, and configuration. Unknown or scheduled
merge requests on the same PR remain publication blockers across lifecycle changes.

A clean candidate is queued through validation-only provisioning (`skipAgent`):
no coding agent is started and validation attempts/task retry budgets are not
reset. Candidate publication, automatic approval and dependent delivery are held.
Configured validation and independent review must pass against the selected
source (only proven same-pod no-op checkpoint lineage may extend it). The task
returns to ready for a **new authenticated human approval**. Conflicts and failed
checks retain the original work; a clean Git rebase is not passing validation.

Inspect with `ap source-recovery POD --json` (or its ordinary text output). The
read-only `approvalRewrite` projection distinguishes preparing, prepared,
checking, checks-held (failed/interrupted invocation), and checked source; it grants no adoption, retry or publication
permission. A prepared candidate interrupted before activation can be verified
and selected by ordinary approval without repeating preparation. An admission
without a certified candidate remains reconciliation-required, not replayable.
A failed checks-only invocation requires its exact execution/retry evidence;
ordinary Rework/Resume cannot bypass the rewrite selection or restart an agent.
Fix validation and Retry checks eligibility must report that custody before
accepting a request; a request receipt is not proof that execution started.
Fresh validation must recreate its declared dependencies, not inherit a coding
worker's temporary installations; see [fresh validation setup](fresh-validation-setup.md).
For a settled failed sandbox selection with immutable execution ownership, use the
[rewrite-owned repair continuation](approval-rewrite-repair.md). It preserves both
originals and requires manual checkout access, separate retry permission, fresh
checks/review and a later human approval; no live recovery is implied.

New approval publishes the checked source using an explicit lease against the
**recorded predecessor SHA**, never a late remote observation or mutable
`origin/<branch>` ref. If the remote already equals the candidate, observation
confirms the receipt without another push; another remote head/deletion refuses
overwrite. Lost responses and daemon restarts preserve the original lease.
Legacy explicit update-from-base allowances also require a genuine earlier
publication receipt; a boolean allowance or tracking ref alone is insufficient.
Parent-bound fix publication uses its recorded merge source as predecessor.

Original source/resources remain held independently of the candidate's current
container. Neither completion nor these records authorizes deleting historical
source, releasing reports, or settling an uncertain Azure wakeup. Old incidents
without a rewrite binding do not acquire retroactive force-push authority; retain
and inspect their exact source before any separately authorized recovery.
[Retention-safe continuation](retained-pod-continuation.md) can explicitly select
an exact current remote source into an independent checkout, preserve the old
source/resource, and require fresh configured checks/review and a new human
approval. It grants no historical force lease and never rewinds the remote.

## Explicit recovery of an uncertain ADO request

Use only after explicit human authorization to retry an old request whose outcome
is unknown. An active PR does not prove that the original mutation was rejected.
This action accepts that uncertainty rather than fabricating a provider response.
It is never invoked automatically by approval or polling.

The operator must collect a fresh ADO PR response, inspect the exact retained
source, and accept the unknown original outcome. The CLI requires a database
backup before apply. It supports only validated, uncompromised pods with an exact
unresolved attempt at least 30 minutes old. The PR must be active, mergeable,
source/target-bound, and have no auto-complete, completion options or queued
completion. Local source must be clean and match the admitted head and branch.

Evidence JSON: `{ "observedAt": "<UTC timestamp>", "prUrl": "<full ADO URL>",
"pr": <fresh az repos pr show JSON> }`. Evidence expires after two minutes.
Protect this file as operator input: the CLI trusts the authenticated operator's
provider snapshot, not a worker-supplied report. Run as the daemon service user.

```
node packages/daemon/dist/db/recover-merge-cli.js \
  --db /data/autopod/autopod.db --pod POD --attempt ATTEMPT_UUID \
  --head EXACT_SHA --actor OPERATOR --reason 'Explicit recovery authorization and evidence' \
  --evidence /path/to/evidence.json
```

Dry-run is the default. To apply add `--apply --accept-unknown-original-outcome
--backup /path/to/unique-backup.db`. This appends an immutable
`merge_operator_recoveries` receipt. It does not alter original requests,
provider observations, source files, or pod status. The next ordinary `ap approve`
can plan delivery again (including choosing the required merge method). An
unresolved subsequent attempt remains blocked and needs its own decision.

Do not run against a scheduled or in-flight completion. Do not delete journal
rows, insert a fake merge response, or set pod status directly. Provider policies
still govern merging, and CI failures still flow through the normal fix-pod path.

## Already-merged PRs (normal polling)

Do **not** authorize another merge request for an already-merged PR.

- An exact source/target match completes normally.
- A human may have added commits before completing the PR. ADO and GitHub can
  also complete when provider comparison proves the recorded publication is
  an ancestor of the merged PR source head (ADO `lastMergeSourceCommit`, GitHub
  the exact merged PR's `head.sha`/`headRefOid`). GitHub re-observes merged PR
  identity around an authenticated full-SHA comparison and requires the recorded
  source to be the exact merge base, with no commits behind. The comparison uses
  the PR's source head, **not** its squash result on the target branch. Repository, PR, source
  branch and target branch must still match. Unsupported providers, unavailable
  comparisons and unrelated histories remain blocked.
- This is evidence of external delivery, not approval of the extra commits or
  authorization to merge an open PR. The original publication and exact-SHA
  merge request remain unchanged. `merge_external_observations` records the
  actual merged head and the provider ancestry proof separately, including in
  task history counts.
- A missing/dirty local checkout no longer vetoes a source-proven delivery.
  Completion is recorded, but unsafe/unverifiable local resources are retained
  rather than deleted; activity explains the cleanup warning. Review retained
  resources separately before releasing them.

Legacy sandbox approvals without a merge journal can also record provider-proven
merged-descendant delivery. Their immutable external-delivery receipt retains
original `headSha`/`treeSha` semantics and separately records `mergedHeadSha` and
ancestry proof; it does not fabricate a daemon merge request or validate the
additional commits. This observation runs before sandbox wakeup and continues to
hold the original resource while ignored reports remain pending. Dirty/missing
legacy retained source, unowned checkpoint lookalikes, unavailable provider proof,
wrong targets and unrelated histories still require reconciliation.

New fix pods publish through a durable parent-bound handoff before completing.
`fix_source_handoffs` records the originating fix lifecycle and superseded intent;
source receipts and merge intents are append-only. Polling recovers the
push/receipt/plan crash windows from exact provider evidence. An uncertain or
scheduled earlier merge cannot be replaced by another fix push.

## Legacy fix published without a handoff

Prefer normal polling above. If an older completed fix published a replacement
source that is **not** a descendant of the parent's recorded source (for example,
following a rebase), automatic ancestry cannot establish delivery. A human must
verify that the actual merged source delivers the original task.

After deploying code and applying migrations 214/215, quiesce the daemon while
running this operator-only command. Obtain the same fresh authenticated ADO
snapshot described above; it must show `status: completed` and
`mergeStatus: succeeded`. Supply a clean checkout of the exact
`lastMergeSourceCommit`, on the recorded PR source branch. `--source` may be an
isolated recovered checkout when the old fix worktree is gone. Do not take the
source or evidence from an untrusted agent report.

```
node packages/daemon/dist/db/recover-merged-fix-cli.js \
  --db /data/autopod/autopod.db --pod PARENT --fix CANONICAL_FIX \
  --source /path/to/verified-merged-checkout \
  --actor OPERATOR --reason 'Verified the merged fix delivers the original task' \
  --evidence /path/to/evidence.json
```

Dry-run is the default. Apply requires `--apply --accept-merged-fix-source
--backup /path/to/unique-backup.db`. It records the operator, reason and provider
snapshot with a parent-bound source handoff, then plans the new source. It never
pushes, requests another merge, overwrites the original journal, or sets pod
status. Resume the daemon: its normal provider lookup confirms completion.

The command refuses active/noncanonical fixes, replaced parent lifecycles,
uncertain/scheduled merge requests, mismatched targets, dirty source and stale
provider evidence. If a handoff already exists, use normal reconciliation instead
of creating another operator receipt. Keep the original resources and backup
until the delivery and cleanup outcomes have been verified.
