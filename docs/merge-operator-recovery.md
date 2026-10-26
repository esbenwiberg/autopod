# Operator recovery of an uncertain ADO merge

Use only after explicit human authorization to retry an old request whose outcome
is unknown. An active PR does not prove that the original mutation was rejected.
This action accepts that uncertainty rather than fabricating a provider response.
It is never invoked automatically by approval or polling.

The operator must collect a fresh ADO PR response, inspect the exact retained
source, and accept the unknown original outcome. The CLI requires a database
backup before apply. It supports only validated, uncompromised pods with an exact
unresolved attempt at least 30 minutes old. The PR must be active, mergeable,
source/target-bound, and have no auto-complete, completion options or queued
completion. Local source must be clean and match the admitted head and branch.

Evidence JSON: `{ "observedAt": "<UTC timestamp>", "prUrl": "<full ADO URL>",
"pr": <fresh az repos pr show JSON> }`. Evidence expires after two minutes.
Protect this file as operator input: the CLI trusts the authenticated operator's
provider snapshot, not a worker-supplied report. Run as the daemon service user.

```
node packages/daemon/dist/db/recover-merge-cli.js \
  --db /data/autopod/autopod.db --pod POD --attempt ATTEMPT_UUID \
  --head EXACT_SHA --actor OPERATOR --reason 'Explicit recovery authorization and evidence' \
  --evidence /path/to/evidence.json
```

Dry-run is the default. To apply add `--apply --accept-unknown-original-outcome
--backup /path/to/unique-backup.db`. This appends an immutable
`merge_operator_recoveries` receipt. It does not alter original requests,
provider observations, source files, or pod status. The next ordinary `ap approve`
can plan delivery again (including choosing the required merge method). An
unresolved subsequent attempt remains blocked and needs its own decision.

Do not run against a scheduled or in-flight completion. Do not delete journal
rows, insert a fake merge response, or set pod status directly. Provider policies
still govern merging, and CI failures still flow through the normal fix-pod path.
