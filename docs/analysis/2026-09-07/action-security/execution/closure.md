# Action security closure review — incomplete

The local implementation and boundary checks are complete. The Goal is **not complete**: the required dependency audit fails on baseline dependencies, and the final combined source still needs the complete pipeline after the dependency prerequisite is resolved. See acceptance.json and prerequisites/README.md.

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
| W4.2 full pipeline | **BLOCKED:** dependency audit failed. Other required stages passed on checkpoint 3; final scoped-address changes pass 355 focused tests. Full final combined-source pipeline is outstanding. |
| W4.3 closure | This provisional closure is reviewable; final closure awaits W4.2. |

The final focused receipt is receipts/final-boundary-green.txt: **355 tests passed across 20 files**. The complete pipeline receipt is receipts/checkpoint-3-full-validation.txt and its identity JSON: exact clean source `1ea58def2926636e6ab0159cd258652e89591061`, exit 1 solely for dependency audit. Do not describe that run as green. A supplementary raw tsc check reports pre-existing test typing debt outside the configured repository typecheck; newly introduced typing issues were corrected.

## Local commits and integration

- 7f227253: bounded HTTP response consumption and cancellation.
- 37d37673: pinned destinations, redirect rejection, IPv6 normalization, local TLS proof.
- 1ea58def: safe action diagnostics, logging, audit redaction and failure integration tests.
- The following checkpoint adds scoped-address handling, consumer verification and this provisional closure.

No dependency manifests, migrations, profile fields, pod lifecycle code, operator UI, cloud resources or live pods were changed. The other task's last inspected diff has no changes in action/SSRF paths. Its dependency changes are prepared as an exact prerequisite patch; they are not applied here. Integration with its complete reliability branch is unverified.

## Compatibility and limits

Generic HTTP actions must configure the final destination URL and explicit auth; automatic redirects and URL credentials are intentionally rejected. Responses above 2 MiB decoded bytes now fail even on text/log/error paths. Unknown exception detail is withheld, so diagnosis uses safe categories and correlation rather than raw SDK output. DNS resolution itself may settle after cancellation, but cannot cause a late HTTP operation. These tests prove local transport and code behavior, not a deployed release or live provider acceptance.

The remaining concrete step is approval to reuse the existing six dependency files from 83c561e69413c71f1195f436621d2a150162af10, followed by dependency compatibility validation and a passing full pipeline on the final combined commit. Broad dependency changes were not made under the narrower transport scope. No push, PR, merge or deployment is required for this local Goal.
