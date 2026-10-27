# Reviewing scheduled scan reports

Report completion records a scan outcome. It does not mean a patch was delivered. A repair requires a recorded human selection followed by a separate launch.

Use the schedule's Scan reports view on mobile or desktop. Load older reports, then load more findings or older decisions as needed. Unresolved findings include earlier runs for the same recorded repository. A report with no repository scope cannot enumerate those findings; open an earlier report with recorded repository evidence.

Read-only CLI commands:

```sh
ap schedule report-page JOB_ID
ap schedule report-page JOB_ID --before REPORT_ID
ap schedule review REPORT_ID
ap schedule findings REPORT_ID --after FINDING_CURSOR
ap schedule decisions REPORT_ID --before DECISION_CURSOR
```

Use the returned continuation cursors. A page with no readable items may still have a next cursor when its stored records are unavailable. Loaded counts are not a claim that no other findings exist.

Malformed, oversized or unsupported stored evidence remains stored. The review shows the affected report, finding or decision and an explanation. A null policy, collection, judgment, count or cost means unavailable evidence; it is not an empty result or zero cost. A stored completion status remains visible for history, but unavailable report evidence cannot establish a clean result or authorize new repair work.

Reconcile the original evidence before recording a new decision or launching a repair. You can remove an unavailable selection from a local draft; this does not delete an already-recorded decision. Recorded decisions remain in history.

API clients should use `GET /scan-reports/:id/review` and its finding/decision continuation endpoints. `evidenceDiagnostics` describes unavailable report fields, while `diagnostics` identifies unreadable or unenumerated review records. The legacy report list retains its array shape with per-report diagnostics. A legacy detail read that encounters unavailable evidence returns the paged review with explicit continuation cursors. Mutation endpoints still reject unavailable authority with a reconciliation error.

## Security scope

Manual Run and cron use the same deterministic collector. Policies without `scope`
(including existing Security scan schedules) now check `current_tree`: secrets in
current tracked text content and current dependency manifests at the frozen head SHA.
The recorded Git delta and optional rolling window remain context; an unchanged HEAD
still runs security checks. Existing secrets are not subtracted as baseline findings.
Historical reports keep their original evidence and status.

Set `scope: "delta"` in API policies, use CLI `--scope delta`, or select desktop
Delta-only checks to retain new-findings-only delta behavior. Only these runs may
finish `empty_delta` with scanners `skipped_empty`. Current-tree successful checks
finish `complete`, even with an empty delta. Completion is not a clean verdict when
there are findings; unavailable or failed checks finish `incomplete` with unknown counts.

Dependency audits currently support npm lockfile v2/v3 (`package-lock.json` or
`npm-shrinkwrap.json`) and send dependency metadata to the public npm advisory service.
Other recognized ecosystems, or a manifest without a supported lockfile, report
incomplete coverage. Auditing uses an isolated temporary directory, ignores scripts,
and never installs repository code or applies fixes. Advisory checks run even when
manifests did not change.

Collection is bounded: 10,000 current-tree paths, 200 delta paths, 2 MiB per Git
command/blob, 32 MiB aggregate blob reads, 1,000 findings, and a 60-second scanner
budget (Git commands additionally have 15-second limits). Unsupported binary content,
exceeded limits, detector failures and unavailable advisory services cannot establish
a clean result. Partial findings remain redacted and durable; inspect diagnostics
and arrange a narrower or supported scan when coverage is incomplete. Reports and
triage remain immutable evidence; repair launches still require human selection.
