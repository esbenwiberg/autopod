# Progress

## Activation

Verified detached baseline and created dedicated branch. Other task remains active; action and SSRF paths have no current overlap. Dependency installation started in this worktree. Next: reproduce full-body timeout, cancellation and streamed byte-limit defects. All acceptance criteria remain not-run.

## Checkpoint 1: HTTP body bounds

Baseline local transport reproductions: 8 failed, 2 passed. Fixed timeout extending through body receipt, caller cancellation, streaming 2 MiB decoded byte limits, and early stream cancellation. Shared helper now resolves after a bounded response is fully received so text/error consumers are protected too. No provider request retries added. Two test-pipeline fixtures used incomplete Response-shaped objects; changed those to actual Response objects without changing assertions. Focused run: 99 passed across 8 files. Source hashes retained in receipts/http-resilience-source.json. Full pipeline not yet run.

Initial sandbox socket EPERM prevented live fixtures; authorized escalated runs used only task-owned loopback listeners. The RED receipt truncates long synthetic payload lines and retains failure assertions and counts. Next: generic HTTP DNS/redirect transport reproduction and enforcement. DNS validation is currently outside the shared request deadline and is still outstanding.

## Checkpoint 2: pinned destination transport

Checkpoint 1 commit: 7f227253. It includes local evidence, not full pipeline proof. Whitespace-only receipt cleanup follows in this checkpoint.

Seven RED destination tests demonstrate mapped IPv6 private address bypass, redirect following, independent DNS resolution and DNS outside the action deadline. Generic actions now use a request-local Node HTTP/TLS transport pinned to the validated answer set, retain hostname/TLS checks, and reject redirects. No manifest or lockfile change. Tests inject controlled DNS results/transport only through constructor dependencies. Production request/profile input cannot select these seams.

Local TLS fixtures prove trusted matching certificates succeed, untrusted certificates fail and trusted hostname mismatches fail before an HTTP request. Expanded body-limit/deadline suite exercises both native fetch and the pinned transport, including decompression and socket cleanup. 112 tests pass across 6 files. Workspace build passed (daemon freshly built, six unrelated cached package tasks). Full pipeline and safe error/log/audit work remain open.

Compatibility: generic HTTP actions reject 3xx responses and URL-embedded credentials; administrators must configure a final URL and explicit auth. All shared action requests now buffer at most 2 MiB decoded bytes under a full-body deadline, including text/log/error bodies previously unbounded. No automatic retry of side-effecting requests. DNS lookup itself may settle after cancellation, but no late request is issued.

Next: reproduce synthetic credential leakage through actual action logs, audit records and tool responses; remove unsafe error content while retaining useful diagnostics and truthful metadata. Current action/SSRF overlap check still clear.

## Checkpoint 3: safe action diagnostics

Checkpoint 2 commit: 37d37673. Three RED failures demonstrate opaque credential leakage through upstream errors, credential lookup exceptions, and nested audit values. Failure responses now withhold raw upstream text and raw exception properties, retaining a safe category, action, HTTP status where available, and a UUID matching log/audit entries. Structured action logging and audit parameters use bounded recursive redaction, including URL credentials/query values. AsyncLocalStorage scopes observed credentials to the individual concurrent action; handler instances and their rate-limit state remain shared as before. No audit history is rewritten.

Raw failure content is withheld even without optional PII policy. sanitized=true means content was removed; piiDetected=false and quarantineScore=0 make no unperformed PII/injection classification claim. The same safe response passes through the real exported MCP formatter. Denied approval/resource requests perform zero credential lookups, DNS guards or handler operations, and create no execution audit record. 276 focused tests pass across 17 files, including preserved audit hash verification, provider behavior, and HTTP/TLS fixtures.

Additional raw `tsc --noEmit --project packages/daemon/tsconfig.json` is not the repository's configured typecheck and reports existing test typing debt (for example unchanged action-engine.test.ts lacks getSafetySummary in a mock and uses an invalid group). New fixture typing/import errors found by this extra check were corrected; none remain in new test files or changed production modules. Required repository typecheck and full pipeline are still pending on final committed source.

Latest overlap check shows no concurrent changes in action/SSRF paths. Next: run ./scripts/validate.sh on the checkpoint commit without editing source during the run, then review and close every criterion. Do not mark the overall goal complete before that evidence exists.
