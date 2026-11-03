# Duplicate-work preflight

Duplicate-work preflight considers **active work only**: matching task/contract
requests in the same repository and base branch can require review while another
execution is admitted or an earlier request is still queued.

Finished pods (`complete`, `failed`, `killed`, or `rejected`) and deleted pods do
**not** block a launch, regardless of their age. Their immutable receipts and task
history remain intact. There is no seven-day blocking window.

Nonterminal work still counts: queued, provisioning, running, waiting for input,
paused, research-ready (active human decision), validating, validated, review-required,
approved, merging, merge-pending and killing pods. Active work never expires out of this check. A blocked request
which was never admitted is not an admitted execution.

This policy is not execution reconciliation or cleanup authorization. It does not
settle an unknown exit, replay a lost mutation, release retained source/reports,
reset accounting, grant a retry or waive validation. Independent ownership,
custody and budget checks remain in force.

## Queued PR repair identity

The queued `[PR FIX] Awaiting queued feedback.` task is a placeholder, shared by
unrelated repairs. Its task/contract hash is scoped to the canonical PR address
in the execution's bound repository. Dispatch verifies immutable task parent
membership, the parent's current canonical child, the shared single-PR series
owner selected by fix admission, PR URL, branch, base and frozen repository.
Explicit child series/mode metadata must agree with its parent; absent legacy
metadata remains supported. Missing, foreign, stale or contradictory current
ownership refuses dispatch.
GitHub case/trailing-slash and supported ADO legacy/canonical URL equivalence use
the existing delivery identity parsers; no provider calls are made.

Older generic receipts remain immutable. An active generic receipt or queued
placeholder stops conflicting only when independent retained child and parent
lineage proves a different canonical PR with matching repository, branch, base
and child ownership. After parent-first deletion clears the live child pointer,
immutable execution ancestry and the archived parent remain the witness. Unknown
or contradictory lineage still blocks. Deleted/terminal executions remain
nonblocking under the active-only policy, regardless of receipt identity.

Receipt candidates use the existing repository/base/work-hash index, capped at
101 (more than 100 requires reconciliation), before indexed live/archive point
lookups. Deleted history does not consume this active bound. No receipts are
rewritten and no parallel identity ledger or schema migration is introduced.

## Exact intentional reruns

An authenticated rerun may authorize exactly its named direct conflict, or the
exact execution set recorded on the displayed blocked request. A second active
execution or any changed displayed conflict set requires a new decision. Linked
repair/rework stays in its logical task; an unrelated rerun naming only the root
does not authorize additional linked executions.

Placeholder equality is not an executable feedback handoff. New and historical
unlinked intentional placeholder reruns refuse dispatch without rewriting their
audit records. Continue the canonical repair, or supply meaningful executable
work through the authorized workflow. Ordinary executable reruns retain their
audited identity and idempotency behavior. None of these decisions resets or
waives task token budgets, retry admissions, unknown termination reconciliation,
frozen-source custody or validation gates.
