# Retained sandbox approval recovery

Approval of a validated sandbox PR or branch preserves ignored workspace reports
before publishing source, merging, or removing the original sandbox. Readiness
is a separate verdict: a ready pod can still encounter a delivery failure.

One approval runs per pod in the daemon. Overlapping API, automation, bulk, or
manager requests receive HTTP 409 `APPROVAL_IN_PROGRESS`; they do not join or
change the active request's options. Wait for activity/status before retrying.
A failed attempt releases admission for an explicit retry; unrelated pods remain
independent. Desktop approval controls show pending delivery while awaiting the
response. A dropped connection does not cancel daemon work.

Activity distinguishes preparation, waking the retained sandbox, and preserving
workspace reports. Wakeup has a 150-second preservation budget (Azure resume
reconciliation is bounded at 145 seconds); export then gets its own 120 seconds.
The existing desktop request budget remains 300 seconds, which also includes
readiness and publication. These are stage bounds, not a promise that all delivery
work fits inside the desktop request budget.

Azure resume observes Running before any export. Transitional states are polled;
only a specifically rejected ResourceLocked resume can be retried after backoff
and a fresh stopped-state observation. An accepted resume is observed, not posted
again. Auth, missing resources, terminal states, and unrelated conflicts fail.
HTTP calls have bounded fetch deadlines and the entire reconciliation (including
authentication and response bodies) has a deadline. No generic write retry is added.

On wakeup or export failure, check the stage in activity and daemon logs, inspect
the retained sandbox's availability, then explicitly retry ordinary approval once
the issue is resolved. Do not delete the sandbox, skip preservation, or restart an
agent to bypass the failure. Late extraction cannot publish a snapshot or replace
a previous receipt; stale lifecycle ownership cannot publish or trigger cleanup.
A copy timeout from older versions covered wakeup and export together and cannot
identify which stage stalled without additional evidence.
