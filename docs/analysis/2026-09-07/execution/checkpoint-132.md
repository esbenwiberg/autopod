# Checkpoint 132: release readiness and exact identity guard

Current release candidate is `feeb55d6d9bed010b23a37cf18d2c597da2df408`. Application packages are byte-identical to the successful CP131 canary source `9abf64b1`; only the deployment script and its regression tests changed. All six workstreams retain their prior implementation and acceptance evidence. The goal remains incomplete; no publication, deployment or restart occurred.

## What changed and what passed

The opt-in `--verify-release` checks bounded public health JSON after the existing local/external health gates. It requires the expected full commit, a clean build identity and a SHA-256 validation implementation identity. A failed verification after a swap attempt retains the existing expiring maintenance drain instead of explicitly removing it. Default deployment behavior is preserved. This drain checks API pod admission; it is not proof of a global scheduler/worker fence and must be renewed before expiry if needed. The option does not make schema downgrade safe.

The RED receipt demonstrates that the new option was absent (`unknown arg`), not a reproduced production incident. GREEN shell cases verify exact, wrong, dirty, missing and unavailable release identities, restart occurrence and drain deletion behavior. Existing active-pod, queued-pod, force, health retry, truncated output and cleanup checks still pass. [Diff](receipts/checkpoint-132-deployment-guard.diff), [RED](receipts/checkpoint-132-release-guard-red.txt), [GREEN](receipts/checkpoint-132-release-guard-green.txt).

The contract-required full pipeline passed on the clean committed candidate: 6,375 package tests, one existing platform skip, 11 standalone Node tests, deployment/cleanup shell checks and install/lint/build/typecheck/audit/secret scan. Test tasks were 15/15 successful, 14 cached. One moderate advisory remains. [Identity](receipts/checkpoint-132-full-validation-identity.json), [output](receipts/checkpoint-132-full-validation.txt). The exact raw output is also retained as gzip; the readable copy only strips trailing whitespace. Earlier supported operator interactions, 357 Swift tests, snapshot upgrade and live capability checks remain valid within their byte-identical application scope. [Source comparison](receipts/checkpoint-132-source-identity.json).

## Hosted read-only readiness

The pinned VM remains `autopod-daemon` in `ewi-sandboxes`, subscription `06bb959b-9458-41a6-bdf5-77cc12feaab9`, immutable VM ID `3addc9bc-4812-4892-98d6-c40d5ab893c0`, Sweden Central. At 07:37 UTC on September 10 the service PID was 125941 and current symlink/service cwd both resolved to `/opt/autopod/releases/ca92847a/packages/daemon`. Checkout `ca92847a64aa11d58b5a43ca29659262fe85ada9` was clean. Entry-bundle size/hash/mtime are recorded, but loaded JavaScript bytes remain unattested.

The service descriptor matched `/data/autopod/autopod.db`, device/inode `2049/13107203`, 877,150,208 bytes, schema maximum 153. All eleven restart-blocking status counts and queued count were zero; free space was 139,107,713,024 bytes. Service and database identity were stable at the end. These observations require refresh before cutover. [Readiness receipt](receipts/checkpoint-132-release-readiness.json).

An authenticated GET of the existing maintenance endpoint returned 200 with inactive drain. No POST/DELETE was issued. The receipt's `mutations:false` describes the HTTP operation; the route itself may delete expired maintenance records as housekeeping, so this is not a claim of zero server-side writes. [Drain receipt](receipts/checkpoint-132-drain-readiness.json).

## Historical API cause is still unknown

The journal before the original report cutoff, September 7 at 08:27:28 UTC, contains no retained entries. The report-day journal starts at 11:49:55 UTC and contains only the classified successful route responses. Its later disk-full/other errors cannot establish the earlier failure cause.

A bounded archive pass was incomplete at its 32 MiB aggregate limit; that limitation is retained. Follow-up range inspection and complete bounded current-syslog parsing found 1,877 pre-report lines, including 406 valid Node JSON records, but zero request-completion, unhandled-error or `/pods` route mentions. The fully read 442,710,951-byte `syslog.2.gz` ends August 23, before this incident. No raw log contents were exported. [Initial limited pass](receipts/checkpoint-132-log-archive.json), [ranges](receipts/checkpoint-132-log-ranges.json), [window resolution](receipts/checkpoint-132-syslog-window.json).

These retained sources cannot supply the missing request-correlated trace. Separately retained traces may still exist elsewhere; exhaustive absence is not claimed. W4.5 stays partial. The malformed-row regression proves a supported defensive correction, not this historical diagnosis.

## Next unfinished action

The remote main read still returned integrated `b75fbf0b7e2c4ea455838a6e4df6537665a7a8cc`; the candidate remote branch is absent. The [publication and release packet](release-and-acceptance-packet.md) prepares a scoped branch push for approval under the original goal's explicit publication boundary. No further canary approval is needed. Production activation remains separately gated by fresh backup/restore, worker admission/ownership and recovery prerequisites. The missing historical trace also remains open.
