# Duplicate-work preflight

Duplicate-work preflight considers **active work only**. Identical task/contract
requests in the same repository and base branch can require review while another
execution is admitted or an earlier request is still queued.

Finished pods (`complete`, `failed`, `killed`, or `rejected`) and deleted pods do
**not** block a new launch, regardless of how recently they ran. Their immutable
receipts and task history remain intact. There is no seven-day blocking window.

Nonterminal work still counts, including queued, provisioning, running, waiting
for input, paused, validating, validated, review-required, approved, merging,
merge-pending and killing pods. Active work does not expire out of this check.
A blocked request which was never admitted is not an admitted execution.

PR repairs use their canonical PR identity rather than treating the shared
queued-feedback placeholder as equivalent work across unrelated PRs. The normal
parent/task/repository/branch ownership checks still apply.

An intentional rerun remains an explicit, reasoned decision when active conflicts
exist; it does not authorize additional unreviewed executions. A generic PR repair
placeholder is not an executable handoff: continue the existing canonical repair
rather than launching an unlinked copy without its feedback.

This policy is not execution reconciliation or a cleanup authorization. It does
not settle an unknown process exit, replay a lost mutation, release retained
source/reports, reset task accounting, grant a retry, or waive validation. Those
independent ownership, custody and budget checks remain in force.
