# Desktop fleet cards

The redesigned fleet cards use short repository names (`PowerGantt`, for example).
The tooltip and accessibility label retain the full credential-free repository
identity. Clicking the repository still filters by its full identity; clicking the
PR opens the external pull request, and clicking the title selects the pod.
These controls show a pointing-hand cursor, subtle background feedback and filled
SF Symbols on hover. Normal profile names remain beside the model; opaque profile
UUIDs/configuration IDs are omitted rather than presented as useful metadata.

Status text and its dot share adaptive semantic colors: muted blue for work,
amber for review/input/merge waits, green for approval/completion, red for failure
or killing, and gray for inactive states. Text labels remain visible; color is not
the only status indicator.

## Active time

`Active 12m` means recorded time in the **running and validating lifecycle
states**, across pauses, retries and rework. It includes idle time within those
states; it is not CPU time, provider inference time, container uptime or billed
time. Queueing/provisioning, paused/awaiting-input, approval, merging and
merge-pending/CI waits do not accumulate. Completed, failed and killed pods freeze.
A daemon outage while a pod remains in a counted state is still state time, not
proof of uninterrupted execution.

Migration `231_pod_active_time.sql` creates a small per-live-pod ledger. SQLite
triggers initialize newly inserted pods and account for every actual status
change transactionally; repeated status writes and heartbeats do not reset the
clock. Compact discovery and detail responses expose the optional
`display.activeTime` object (`elapsedMs` accumulated from closed intervals and
`activeSince` for an open interval). The desktop updates the open interval once
per minute without loading event history for each card.

**There is no historical backfill.** Pods created before this migration, deleted
pods with retained history, or older daemon responses show `Active —` when timing
coverage is missing. Existing pod age is never relabeled as active time. A stale
open interval received ahead of a non-active status refresh also shows unavailable
until the authoritative projection arrives. The legacy desktop card/detail
elapsed-time displays are unchanged; this metric applies to redesigned fleet cards.

## Verification

Regression coverage lives in `pod-active-time.test.ts`, pod route tests and
`DesktopCardPresentationTests.swift`. Tests cover interval accumulation,
non-active states, repeated updates, rollback, deletion, unavailable history,
older transport decoding, profile IDs, repository names, adaptive text contrast,
and native rendering at 250/420-point widths in both appearances.

To retain native card captures while running the focused Swift tests, set
`AUTOPOD_CARD_SNAPSHOTS` to a local directory. Use the project's serialized desktop
test runner (`scripts/test-desktop.sh`) for the full AppKit/WebKit suite.
