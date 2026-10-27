# Operator recovery of an uncertain ADO merge

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
- For ADO, a human may have added commits before completing the PR. Polling can
  also complete when ADO's commit comparison proves the recorded publication is
  an ancestor of `lastMergeSourceCommit`. The comparison uses the PR's source
  head, **not** its squash result on the target branch. Repository, PR, source
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
