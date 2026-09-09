# Next verification proposal after approved inspection

The one approved checkpoint-106 metadata inspection succeeded on September 9 at 04:54 UTC. This packet proposes the next bounded checks; **they are not yet authorized or executed**. No publication, deployment, service restart, provider call, canary or live pod mutation is included.

## A. One sampled on-VM backup restore

[Reviewable Python payload](fixtures/verify-hosted-backup-sample.py). Its SHA-256 is pinned in [the proposal manifest](receipts/checkpoint-107-proposal-manifest.json). Four real local SQLite tests cover successful isolation, newer active data, corruption and foreign-key failure. These are preparation evidence only.

Target the same verified Azure VM resource in subscription `06bb959b-9458-41a6-bdf5-77cc12feaab9`, resource group `ewi-sandboxes`, VM `autopod-daemon`, immutable VM ID `3addc9bc-4812-4892-98d6-c40d5ab893c0`, via Azure Run Command.

Approved-source proposal: `/data/autopod/autopod.db`, device/inode `2049/13107203`, freshly matched to an open service descriptor. If identity changes or the service does not have that database open, stop. Inspect no alternative database automatically.

Backup selection is one regular numeric-name `.db` file in `/data/autopod/backups`, newest among files 60 seconds to 30 minutes old and at most 1 GiB. Exclude symlinks, limit directory enumeration to 512 entries, verify opened identity/size/modification time and recheck stability after copying. This rule accommodates the observed fifteen-minute rotation without authorizing arbitrary backup paths. `1788929381287.db` was the newest file at the first inspection, but may have rotated away before approval; do not claim it remains current or select a stale file if none meets the rule.

Create one private directory with prefix `/data/autopod/autopod-verify-`, mode 0700. Copy the selected backup there, never activate it. Maximum copied database: 1 GiB; require space for two copies plus 128 MiB reserve. The first inspection observed 139,200,618,496 available bytes; recheck at execution because that is not a reservation. Allow 180 seconds for the verification with cooperative copy/query deadlines. Filesystem operations can exceed cooperative deadlines under a kernel/storage stall; record any unresolved cleanup rather than claiming removal.

Checks: checksum agreement for the copied bytes; SQLite integrity and foreign keys; a create-table/write-capability probe rolled back on the **private copy only**; schema signature and all-table count/latest-update watermark signatures compared with a read-only snapshot of the intended active DB. Cap the catalog at 256 tables. Hashes/counts do not establish full row-by-row equality or prove a historical backup creation receipt. The deployed main backup implementation does not write the candidate's new provenance receipts; do not manufacture one.

Export only a small JSON verdict with backup filename/byte count/checksum, integrity/foreign-key/rollback results, schema/watermark signatures and match booleans, catalog counts, observed time, active-identity stability and cleanup status. No database bytes, raw rows, SQL/schema text, task content, environment, credentials or backup data leave the VM. Remove only the newly created private directory. If removal fails, report its exact task-owned path as pending; do not delete or prune any existing backup, journal or production data.

Estimated incremental provider/sandbox spend: **$0**. No new cloud resource. Existing VM billing continues. Expected I/O includes reading one backup, writing and rereading its private copy, integrity checks and read-only live catalog/watermark queries. This adds bounded disk load to the existing VM; approval must include that temporary copy and data handling.

## B. Four authenticated API availability reads

[Reviewable local client](fixtures/check-hosted-api-status.py), hash pinned in the proposal manifest. This request specifically includes normal cached authentication and transient retrieval of potentially sensitive pod/cost API responses.

Use the existing `ap token` path; keep the bearer token in memory and send it only to `https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com`. Disable redirects. No token output or persistence, no new account login, and no external message.

One GET each, at most 20 seconds and 2 MiB response per request:

- `/health?detail=full`
- `/pods?compact=true&limit=10`
- `/pods?limit=10`
- `/pods/analytics/cost?days=30`

Record only observation time, route, HTTP status, body byte count and limit/incomplete flags. Response bodies are transient and never logged, stored or exported. This tests current availability; a 200 does not establish the historical outage's cause. No retries or broader retrieval are included. Estimated additional provider/sandbox spend: **$0**.

Automatic approval review rejected these reads after the first inspection because the previous approval covered the prepared guest metadata payload, not bearer-authenticated retrieval of pod/cost API bodies. They did not execute. This packet requests specific approval for A and B; no transport workaround or indirect retry was used.

## Remaining acceptance outside this request

Loaded daemon bundle/CLI/image identities, the required actual-image capability canary and visible native interaction remain unverified. The migration files match main `c0e5a5b4`, but filesystem hashes and release directory names do not prove loaded executable bytes. Current backup restore evidence may satisfy its scoped integrity checks while historical creation provenance remains unavailable. The historical API root cause remains open if current reads are healthy or the bounded journal contains no usable old failure evidence. Paid canary/publication/deployment authority is not implied by approval of this packet.
