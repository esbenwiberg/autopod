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

`[PR FIX] Awaiting queued feedback.` is a shared placeholder. Its task/contract
hash is scoped to the canonical PR in its repository. Dispatch verifies
immutable parent/task membership, the parent's canonical child, the shared single-PR
owner, PR URL, branch, base and frozen repository.
Child series/mode metadata must match its parent when present. Missing, foreign, stale or contradictory ownership
refuses dispatch. Existing parsers handle GitHub case/trailing-slash and ADO
legacy/canonical URL equivalence offline.

Generic historical receipts stay immutable. Only independently retained
child/parent lineage proving a different canonical PR matching repository,
branch, base and ownership excludes an active generic conflict. On normal
parent-first deletion, the archived parent retains its child claim; immutable
execution ancestry survives clearing the live child's parent pointer. Unknown
or contradictory evidence blocks. Terminal/deleted work remains nonblocking.

Verified PR requests use the existing repository/base/work-hash index, capped
at 101; more than 100 requires reconciliation before live/archive point lookups.
An unlinked literal placeholder cannot derive a PR-scoped hash. It additionally
probes live child executions through the execution-receipt index, capped at 101
distinct admitted execution/hash pairs before reconstructing bounded request
identity. This makes duplicate detection independent of admission order. Earlier
scoped receipts still count after executable feedback changes the task or adds
another receipt; changed or missing ownership is not proof of unrelated work.
Only exact hash reconstruction proving different ordinary work or a different
contract excludes a candidate. Unknown hashes remain blocking. More than 100
active candidate hashes requires ownership reconciliation rather than guessing.
Finished/deleted history does not consume these active bounds. Receipts stay
immutable; no new ledger, migration, dispatch permission or retry is introduced.

## Exact intentional reruns

A human rerun authorizes one exact named direct conflict or the exact execution
set displayed on its blocked source request. Any changed set requires a new
decision. Linked rework stays in its logical task; naming its root alone does
not authorize additional linked executions.

Placeholder equality is not executable feedback. New and historical unlinked
placeholder reruns fail closed without rewriting intents. Continue the canonical
repair or supply meaningful executable work. Executable
ordinary reruns retain audited identity and idempotency. They never
reset or waive token budgets, retry admissions, unknown-termination reconciliation,
frozen-source custody or validation gates.
