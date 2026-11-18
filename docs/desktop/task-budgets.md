# Extending a task budget in the desktop app

Open **Work → Cost → Task token budget**, or use the budget editor in a
**Rework task**, **Revalidate only**, or **Resume delivery** repair handoff.
The editor reads the current task ledger rather than the original pod/profile limit.

- Enter a higher **total** token limit above **budget-counted** usage and choose **Save budget**.
  Raw recorded usage remains available separately; it can be much larger because cache reads count at 0.1×.
- To remove the cap, select **Remove token limit (unlimited)**, then save and confirm.
- In a repair handoff, **Save budget and …** first saves the budget, then requests
  the selected recovery through the normal repair controls. Acceptance is not
  completion; follow the observed pod state.

The limit is shared by the logical task, including linked repair pods. Recorded
input includes cached tokens; the limit counts cache reads at 0.1x where the
daemon has the cache split. This is a token cap, not a dollar spending cap.
Changes are audited by the daemon and do not edit a profile, preset, or frozen
launch configuration. An unlimited task cannot be capped again with this control;
choose initial limits when launching new tasks.

Saving alone does not resume execution or grant retry permission. Human-guidance,
Goal, source-custody, provider, and retry checks still apply. If a continuation is
rejected, the successful budget change remains saved and the repair error is shown.
For native Goals, save the budget and use the existing Goal controls to resume.

## A worker stopped at a hard token limit

Choose **Continue coding**, not Resume delivery or Revalidate only. In this handoff:

1. Raise or remove the task budget and save it. Eligibility refreshes after saving.
2. If required, review the displayed worker failure and authorize one retry with a reason.
3. Explicitly submit **Continue coding**. The daemon rechecks the exact stop, preserved
   source/resource, current spending, guidance, Goal/custody and retry permission.

The existing durable Rework request retains the original environment, worktree and
native session. It starts one coding segment without resetting task usage, validation
history or retry limits. Normal checks and independent review still follow, but failed
checks do not automatically start another coding segment. Saving a budget, retrying
checks or losing a request reply never grants another worker execution.

A live hard stop leaves accounting partial. Raising a finite limit cannot certify
unknown final usage: reconcile it through the owning controls or explicitly remove the
limit. Old stops without recorded verified termination/preservation remain blocked;
this feature does not invent historical receipts. Keep their original resources and
use the owning recovery inspection. Native Goals, sidecars and interactive workspaces
retain their specialized controls.

If the budget changed elsewhere, or a response was lost, use **Refresh** before
trying another budget change. The editor retains your draft and never automatically
retries a mutation or recovery. If the connection changes, reopen the editor on
the current daemon. If the daemon does not expose the budget API, its error is
shown rather than changing the original profile as a fallback.
