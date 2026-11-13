# Extending a task budget in the desktop app

Open **Work → Cost → Task token budget**, or use the budget editor in a
**Rework task**, **Revalidate only**, or **Resume delivery** repair handoff.
The editor reads the current task ledger rather than the original pod/profile limit.

- Enter a higher **total** token limit above recorded usage and choose **Save budget**.
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

If the budget changed elsewhere, or a response was lost, use **Refresh** before
trying another budget change. The editor retains your draft and never automatically
retries a mutation or recovery. If the connection changes, reopen the editor on
the current daemon. If the daemon does not expose the budget API, its error is
shown rather than changing the original profile as a fallback.
