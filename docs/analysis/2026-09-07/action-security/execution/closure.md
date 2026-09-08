# Action security closure review — complete

All four workstreams are verified on local source `d98d7b6bdfd254f49b260193cd65581b2b97d83f`. The complete `./scripts/validate.sh` pipeline exited 0 on 2026-09-08 with the same clean HEAD before and after. Install, lint, build, configured typecheck, tests, dependency audit and secret scan passed. The final closure commit changes only evidence documentation; production source remains the tested source.

## Implemented behavior

Generic HTTP actions connect using the validated DNS answer set through a per-request Node HTTP/TLS transport. The original Host/SNI and certificate verification remain intact. Redirects are rejected, including cross-origin credential redirects. URL-embedded credentials are rejected. The address classifier covers equivalent mapped IPv6 representations and rejects malformed or scoped resolver answers.

All shared action HTTP requests consume a bounded body under a deadline before returning a Response to callers. The 2 MiB limit counts decoded bytes during streaming; it covers success, error, text, UTF-8, compressed, and missing/inaccurate Content-Length cases. Cancellation closes upstream resources. Generic DNS validation is inside the same deadline and cannot issue a late request after cancellation. Existing mutating request behavior has no new automatic retries.

Action failures expose safe categories, action identity, status where available and a diagnostic UUID shared with logs/audit. Raw upstream bodies, exception messages, stacks and nested causes are withheld. Logs and audit parameters receive bounded recursive redaction, and observed credentials are scoped to the current action. Failure metadata records withholding without inventing PII or injection classification. Existing audit hashes and approval/resource restrictions remain intact.

## Acceptance evidence

| Criterion | Evidence and current result |
| --- | --- |
| W1.1 destination validation | ssrf-guard tests, mapped-address action regressions, scoped-dns RED regression, and actual browser gate/profile/MCP consumer tests pass. |
| W1.2 connection pinning and TLS | .invalid hostname succeeds only via the approved fixture address; one guard call; Host and SNI retained; matching trusted certificate succeeds; untrusted and wrong-host certificates fail before HTTP. |
| W1.3 redirects | Real local redirect destinations receive zero requests for bearer and custom secret-header cases; actionable redirect rejection. |
| W2.1 deadlines/cancellation | Delayed headers, stalled/slow bodies, caller abort and late DNS fixtures pass; socket/stream cleanup asserted. |
| W2.2 size limits | Success/error chunking, decompression, UTF-8 and absent/incorrect/oversized Content-Length fixtures pass with early reader cancellation. |
| W2.3 compatibility and matrix | Both fetch and pinned transports pass the fixed 60 ms deadline matrix (1,000 ms assertion ceiling; 1,200 ms fixture safety cutoff). Verbose receipt retains individual durations; all action handler suites pass. |
| W3.1 safe sinks | Real pino logs, SQLite audit, engine result and exported MCP formatter contain no synthetic sentinel or upstream injection text in the three failure scenarios. |
| W3.2 diagnostic truth | Action/status/category and matching diagnostic UUID remain; sanitized=true reports withholding, piiDetected=false/quarantineScore=0 make no unperformed classification claim. |
| W3.3 audit/denial | Audit hash verification passes; approval and resource denial perform no credential lookup, DNS check or handler side effect. |
| W4.1 durable evidence | Local checkpoints, baseline reproductions, source hashes and exact validation identity are retained. |
| W4.2 full pipeline | **Verified:** final-full-validation.txt and final-validation-identity.json prove exit 0 on clean d98d7b6b. 5,129 tests passed across seven package suites, one existing Linux-only skip; all 15 test/build tasks succeeded. Dependency audit reports no known vulnerabilities. |
| W4.3 closure | **Verified:** final diff reviewed for destination/TLS enforcement, stream cleanup, failure sinks and scope overlap. Every criterion in acceptance.json is verified; no required local work remains. |

The earlier focused receipt, receipts/final-boundary-green.txt, contains 355 passing tests across 20 files. The final complete pipeline supersedes it for combined-source verification and includes all action, real loopback HTTP/TLS, SSRF consumer and dependency compatibility suites. The earlier checkpoint-3 run remains recorded as failed solely for dependency audit; it is not relabeled. The final daemon count is 4,312 passing tests, with one Linux-only Docker permission test skipped on macOS. A supplementary raw tsc check reports pre-existing test typing debt outside the configured repository typecheck; newly introduced typing issues were corrected. The configured typecheck passed in the final pipeline.

## Local commits and integration

- 7f227253: bounded HTTP response consumption and cancellation.
- 37d37673: pinned destinations, redirect rejection, IPv6 normalization, local TLS proof.
- 1ea58def: safe action diagnostics, logging, audit redaction and failure integration tests.
- 8463317e: scoped-address handling, consumer verification and provisional closure.
- d98d7b6b: the approved dependency prerequisite and compatibility tests; exact source used for the final complete pipeline.

The user approved reuse of the six dependency files with “Go on” on 2026-09-08. Their Git blobs exactly match 83c561e69413c71f1195f436621d2a150162af10, as recorded in dependency-prerequisite-identity.json. No lifecycle, reliability fixture or ledger changes from that commit were imported. Its three offline dependency consumer tests were adapted into this task’s action test directory. Eight daemon compatibility checks exercise actual image resizing, archive extraction, authentication UUID calls and mobile static serving; three additional jsdom checks exercise the real App's routes and links. The final pipeline also rebuilds and tests their consumers.

The other task's checkout at eaa697a70ec0c120fd6b4ae2c1b8405bfa91a81c has no committed or uncommitted differences from the shared baseline in our action/SSRF/new router-test paths. Its checkout, branch and processes remain untouched. Integration with its complete reliability branch is unverified. No migrations, profile fields, pod lifecycle code, production operator UI, cloud resources or live pods were changed here.

## Compatibility and limits

Generic HTTP actions must configure the final destination URL and explicit auth; automatic redirects and URL credentials are intentionally rejected. Responses above 2 MiB decoded bytes now fail even on text/log/error paths. Unknown exception detail is withheld, so diagnosis uses safe categories and correlation rather than raw SDK output. DNS resolution itself may settle after cancellation, but cannot cause a late HTTP operation. These tests prove local transport and code behavior, not a deployed release or live provider acceptance.

No required local prerequisite remains. Optional next acceptance is to integrate this branch with the concurrent reliability branch, rerun validation on that combined source, then separately authorize release or provider verification if desired. No push, PR, merge or deployment was performed or required for this local Goal.
