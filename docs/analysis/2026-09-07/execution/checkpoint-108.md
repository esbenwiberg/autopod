# Checkpoint 108: approved sampled restore and authenticated API availability

The user approved the complete checkpoint-107 next-verification packet. Both approved payload hashes were checked against the committed manifest before execution. The backup verification ran once through Azure Run Command after the immutable VM ID was rechecked; the local client performed its four fixed authenticated GETs once. Both returned normally with empty stderr. No extra API body or token was retained. [Authorization](receipts/checkpoint-108-authorization.json).

## Actual sampled restore: verified

Invocation started 2026-09-09T05:19:00.673490 UTC and Azure returned success at 05:19:33.298360 UTC. The guest completed its checks at 05:19:16.374486 UTC. [Invocation identity](receipts/checkpoint-108-backup-identity.json), [provider response](receipts/checkpoint-108-backup-response.json), [verification result](receipts/checkpoint-108-backup-result.json).

The verified VM remained `autopod-daemon` in subscription `06bb959b-9458-41a6-bdf5-77cc12feaab9`, resource group `ewi-sandboxes`, immutable VM ID `3addc9bc-4812-4892-98d6-c40d5ab893c0`. The intended active database passed its device/inode and open-service-descriptor admission; its device/inode was unchanged at completion.

The selection rule chose `/data/autopod/backups/1788930281287.db`, 877,150,208 bytes, within the approved 60-second-to-30-minute modification-age range and 1-GiB maximum. Headroom admission passed before copying. The single private copy had matching SHA-256 `3624d3be6ef845f4dded1b84be7bbe38891ca9d3b469c43db166e4dcdd473c68`. SQLite integrity and foreign keys passed. A create-table capability probe was rolled back on the private copy; the probe table was absent afterward.

The backup and active database both had 48 tables. Their complete catalog schema signatures matched (`c0fefbf5c2be3861b7eea37a9b9f0e911c5e0845f56484d47201ed528e958ae7`), as did the all-table count/latest-update watermark signatures (`063f8bc703388770c8a6cb266e0f1eb48c33f8f39b241c6ed89f7f166280a93f`). These checks support the observed backup scope/freshness against the intended active database. They do not assert full row-by-row equality or retroactively prove a creation receipt that the deployed legacy backup implementation did not write.

The private verification directory was removed and absence was observed. The active database and all original backup/journal files were not written by the verifier. No restored database was activated. This satisfies the scoped real sampled-restore acceptance; future cutover still needs its own fresh backup/receipt and headroom check.

## Actual authenticated API reads: verified current availability

At 05:19:08–05:19:09 UTC, the approved client returned:

| Route | HTTP | Response bytes | Limit exceeded |
|---|---:|---:|---|
| `/health?detail=full` | 200 | 264 | no |
| `/pods?compact=true&limit=10` | 200 | 30,250 | no |
| `/pods?limit=10` | 200 | 294,858 | no |
| `/pods/analytics/cost?days=30` | 200 | 4,588 | no |

[Status-only receipt](receipts/checkpoint-108-api-status.json). The bearer token was kept in memory, redirects were disabled and bodies were transient. The earlier automatic approval rejection is resolved for these four reads by the user's specific approval; it is preserved as a historical, not current, blocker. No additional requests or retries ran.

These results disprove a current broad failure on the exercised routes. They do not establish the historical September 7 failure's cause, prove every historical record semantically correct or imply that this unpublished candidate repaired production. W4.5 remains partial until appropriate historical evidence is found or the specific missing prerequisite is reported.

## Next unresolved evidence

A separate read-only Azure resource inventory found `sandbox-group-ewi1` and `autopod-spike` in Sweden Central and `autopod-spike-neu` in North Europe. [Inventory](receipts/checkpoint-108-sandbox-groups.json). No sandbox was created, executed, changed or deleted. The source default `autopod-spike` alone cannot select the actual configured hosted group or image.

[Runtime and canary discovery packet](runtime-and-canary-discovery-packet.md) now proposes one bounded metadata read of the actual service checkout/entry-bundle hash/Node version, a fixed allowlist of non-secret sandbox environment fields, a bounded profile image/runtime projection and September 7 sanitized error classifications. Three local tests verify filtering and bounds. That proposal is unrun and needs its own data-scope approval; it does not authorize a canary, deployment or additional authenticated pod reads.

Required actual-image capability acceptance and visible native interaction remain outstanding. Loaded/runtime provenance and historical API root-cause evidence are still limited. The goal remains incomplete. No paid provider/sandbox execution, deployment, restart, publication or live pod mutation occurred. Application source is unchanged from the full-pipeline-tested `90a61141`; this checkpoint adds receipts, acceptance updates and a proposed metadata fixture only.

Final local packet checks passed: three metadata-filter tests, syntax checks, configured Biome check (38 existing warnings), secret scan, proposal hash verification and all acceptance/packet links. Receipt text normalizes trailing whitespace. No application-source changes were made and the previously recorded exact-source pipeline remains applicable to that unchanged source.
