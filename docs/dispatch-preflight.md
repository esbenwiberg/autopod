# Duplicate-work preflight

Duplicate-work preflight considers **active work only**: matching task/contract
requests in the same repository and base branch can require review while another
execution is admitted or an earlier request is still queued.

Finished pods (`complete`, `failed`, `killed`, or `rejected`) and deleted pods do
**not** block a launch, regardless of their age. Their immutable receipts and task
history remain intact. There is no seven-day blocking window.

Nonterminal work still counts: queued, provisioning, running, waiting for input,
paused, validating, validated, review-required, approved, merging, merge-pending
and killing pods. Active work never expires out of this check. A blocked request
which was never admitted is not an admitted execution.

This policy is not execution reconciliation or cleanup authorization. It does not
settle an unknown exit, replay a lost mutation, release retained source/reports,
reset accounting, grant a retry or waive validation. Independent ownership,
custody and budget checks remain in force.

This change does not alter PR-repair identity or intentional-rerun authorization.
