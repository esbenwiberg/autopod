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

Browser-script generation has a finite five-minute reviewer deadline, including isolated
reviewer allocation and preflight, separate from the MCP browser execution deadline.
A timed-out generation is not an executed browser check or a review pass. Confirmed
reviewer cleanup does not prove measured usage: an uncertain run still blocks later
reviewers until its owning reconciliation control records measured usage or an explicit
operator acceptance of unknown spend. Never substitute zero tokens for unavailable usage,
remove the reviewer cap, or treat reconciliation as acceptance of the application.

The existing error codes and 409 status remain unchanged. A task accounting
refusal does not instruct the operator to reconcile a previous reviewer. Reviewer
reconciliation only applies to an actual reviewer record, and never proves an
unsettled coding/runtime invocation exited.

## Explicit finite reviewer allowance increases

For an ordinary settled native task, inspect its separate reviewer allowance:

```sh
ap reviewer-budget POD --json
ap reviewer-budget POD --apply --limit 150000 \
  --request-id OWNER_DECISION_ID --generation EXACT_GENERATION \
  --expected-limit EXACT_CURRENT_LIMIT --evidence-hash EXACT_INSPECTION_HASH \
  --reason 'Owner approved additional reviewer allowance; retain all usage' \
  --ack-usage-retained --json
```

This is an explicit spending decision, not `ap budget` (the whole-task limit),
reviewer usage reconciliation, retry authorization or a review pass. It changes
only an append-only per-pod allowance record. Frozen configuration, presets, all
measured tokens and prior failures remain untouched. For example, 106959 recorded
under a 100000 original ceiling remains 106959 after an approved 150000 ceiling;
the known headroom is 43041. The next admitted reviewer records the exact approval
ID. Each immutable receipt retains the exact approved reviewer-ledger snapshot
and its independently recomputable evidence hash, even if later native accounting
changes a run. Inspection exposes that evidence before approval. Unknown usage is
never zeroed or backfilled. Once a top-up is approved, database fences prevent
reducing/clearing known token amounts or deleting/moving those runs; additional
measured usage can still increase them. The actual reservation route must exactly
match the approved frozen reviewer route to consume the increased allowance.
Every reservation rechecks native measured usage: a new unknown/accepted-unknown
or operator-reported run holds consumption of the increased ceiling even though
the immutable grant remains. This never turns unavailable tokens into zero.

`GET/POST /pods/:podId/reviewer-budget` is operator-only. Apply binds actor,
request ID, exact generation, current finite ceiling and reviewer-ledger evidence.
It refuses stale/decreased/nonfinite values, archived or nonordinary tasks,
unknown review amounts, active/unclean reviewers and unsettled worker/validation
accounting. Exact replay returns the original immutable receipt; changing its
content or authority refuses. Unsupported old daemons fail closed with no fallback
to task-budget changes, preset edits or resets. Approval stays within the same
original launch/reviewer policy and never transfers to another pod or route.

The ceiling retains existing admission semantics: recorded cumulative use at or
above it prevents another review. It does not reserve provider spend, interrupt a
review in flight or guarantee its final token count/bill. Hard whole-task limits
and all execution/source/infrastructure/retry holds remain independently enforced.
An explicit Resume or owning recovery selection is separate; a budget increase
never starts a model or resolves an infrastructure report automatically. Existing
unknown-usage acceptance remains available through reviewer-runs reconciliation,
but this finite top-up path requires native measured reviewer counters. Known
operator-reported amounts remain known (not zero or unknown), with their provenance
retained, but do not authorize this native-measurement-only path.
