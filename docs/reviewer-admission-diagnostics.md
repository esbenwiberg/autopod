# Reviewer admission accounting diagnostics

`ReviewerRunRepository.reserve()` checks admission before inserting a reviewer run.
A refusal can therefore exist with no reviewer run to reconcile. Inspect the task's
current accounting and budget; an earlier launch cap may have since been raised or
removed. For example, a finite hard 120000-token cap with active unknown usage
blocks admission even if the recorded total is below 120000. Removing that cap
changes future admission, not the historical reason for the refusal.

| Condition | Result and operator action |
| --- | --- |
| Active, uncertain/unreconciled, or uncleaned reviewer | `REVIEWER_RECONCILIATION_REQUIRED`: inspect reviewer runs; wait for active work to finish, confirm cleanup, and reconcile uncertain reviewer usage. This guard applies to hard, soft and unlimited task budgets. |
| Finite hard task cap, incomplete accounting | `REVIEWER_RECONCILIATION_REQUIRED`: reports the ledger's accounting reason, effective hard limit, recorded tokens and unknown final usage. Wait for active execution to settle and refresh accounting; unresolved execution/phase telemetry requires reconciliation. No new reviewer was started. |
| Task budget source unavailable | `REVIEWER_RECONCILIATION_REQUIRED`: reports the missing source; restore task budget provenance and refresh accounting. A missing budget source is not proof of an explicitly unlimited budget. |
| Finite hard task cap, complete recorded total below cap | Admitted, subject to reviewer guards/cap. Future provider spend is not reserved by this check. |
| Finite hard task cap reached | `REVIEWER_BUDGET_EXHAUSTED`: reports the effective task limit and recorded total. Inspect usage; any increase requires an explicit operator decision. |
| Soft task cap or explicit unlimited budget | Incomplete task usage alone does not block admission; pending reviewer and reviewer-cap guards still apply. Soft task-cap exhaustion is advisory. |
| Reviewer cap reached | `REVIEWER_BUDGET_EXHAUSTED`: reports the reviewer limit and recorded reviewer total separately from the task limit. Inspect reviewer usage and explicitly revise its budget before retrying. |

The existing error codes and 409 status remain unchanged. A task accounting
refusal does not instruct the operator to reconcile a previous reviewer. Reviewer
reconciliation only applies to an actual reviewer record, and never proves an
unsettled coding/runtime invocation exited.
