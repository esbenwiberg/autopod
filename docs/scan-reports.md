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
