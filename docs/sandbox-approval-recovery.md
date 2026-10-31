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

Azure resume observes Running before any export. Transitional states are polled.
An explicit `409 ResourceLocked` or `429` rejection permits bounded readmission
only after backoff and a fresh stopped-state observation. The resume POST has a
separate 60-second response budget; GET polling requests remain bounded at 15
seconds, inside the unchanged 145-second reconciliation budget. An accepted or
outcome-unknown resume is observed by its initiating caller, never posted again.
Auth, missing resources, terminal states, and unrelated conflicts fail.
HTTP calls have bounded fetch deadlines and the entire reconciliation (including
authentication and response bodies) has a deadline. No generic write retry is added.

A later approval first observes the provider. Running settles a retained wakeup
and permits export. If it is still stopped with an existing request, approval
returns HTTP 409 `SANDBOX_WAKEUP_RECONCILIATION_REQUIRED` with the retained request
ID immediately instead of repeating the full polling budget. This response does
not cancel the original request or authorize another resume.

Inspect authenticated `GET /pods/:podId/sandbox-wakeup` for bounded recorded
history (latest 50 intents, latest 20 evidence entries per intent). It reads the
journal only; it does not contact Azure, settle requests, or wake resources. New
requests retain response status, allowlisted correlation/backoff headers, and
bounded transport error classification. Older unknown requests have no invented
response evidence. Obtain the original provider outcome using the retained
request ID; a stopped state alone does not prove rejection. There is no blind
replay or manual-clear recovery action.

On export failure, or once the provider outcome is resolved, explicitly retry
ordinary approval. Do not delete the sandbox, skip preservation, or restart an
agent to bypass a wakeup or export failure. Late extraction cannot publish a
snapshot or replace
a previous receipt; stale lifecycle ownership cannot publish or trigger cleanup.
A copy timeout from older versions covered wakeup and export together and cannot
identify which stage stalled without additional evidence.
