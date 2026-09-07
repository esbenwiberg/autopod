/goal Implement and validate Autopod action security and HTTP resilience in this task's isolated worktree. Close demonstrated gaps in outbound destination enforcement, request and response resource bounds, and sensitive error handling. Complete all four workstreams below with reproducible evidence and reviewable local commits while preserving the concurrent reliability task's work.

Objective

Make the action execution boundary safe and dependable for unattended operation: agent-supplied inputs must not redirect daemon requests to forbidden destinations, slow or oversized responses must not consume resources indefinitely, and upstream failures must not expose credentials or unsafe content through logs, audit records, or agent responses. Preserve legitimate supported action behavior, approval requirements, resource restrictions, and useful diagnostics.

This is an implementation contract. Research and planning are initial steps, followed by reproductions, fixes, integration verification, and closure. Continue across checkpoints until the required outcomes are proven or specific prerequisites block the remaining work. The overnight estimate is a planning estimate, not a requirement to consume time, expand scope, or repeat passing checks.

Workspace and concurrent ownership

- Start in /Users/ewi/.codex/worktrees/46f5/autopod. Confirm its actual Git root, branch, HEAD, status, and applicable AGENTS.md instructions. Use a dedicated codex/ branch in this worktree if needed; preserve unrelated staged, tracked, and untracked work.
- The concurrent task is "Execute complete implementation goal", task ID 01a07afa-a577-70e1-a800-f4f5de43bf2e. Its last observed implementation checkout was /private/tmp/autopod-durable-execution, and its contract is /Users/ewi/repos/autopod/docs/analysis/2026-09-07/goal-prompt.md. Verify current ownership through read-only task and Git inspection; these locations and observations may have changed.
- That task owns completion/escalation/recovery/delivery, task-wide retries and evidence reuse, dispatch/provider preflight, metrics and operator views, scheduled scans/triage, and release/backup provenance. Do not implement those workstreams here or modify its checkout, branch, ledger, processes, or live resources.
- Before each implementation milestone, compare proposed paths and relevant interfaces with the other task's current committed and uncommitted changes. A separate worktree prevents checkout interference but does not eliminate integration conflicts. Defer overlapping edits and continue independent work. Record any necessary shared-file handoff concretely; do not silently broaden ownership.
- Primary scope: packages/daemon/src/actions/, packages/daemon/src/api/ssrf-guard.ts and its tests, narrowly necessary HTTP transport helpers, and this task's evidence directory. Changes to shared sanitization or logging helpers are allowed only when a demonstrated action-boundary defect requires them and overlap checks are clear. Inventory and verify affected callers before changing shared behavior.
- Avoid migrations, profile fields, pod lifecycle changes, new operator UI, broad crypto rewrites, and unrelated dependency upgrades. If a focused transport dependency is necessary, justify it and keep manifest/lockfile changes scoped.

Starting evidence, to verify rather than assume

At inspected baseline 2d5456ed, api/ssrf-guard.ts explicitly documents a DNS-rebinding gap between validation and fetch. The generic HTTP action handler checks a URL before calling fetchWithTimeout, without binding that call to the resolved addresses. The HTTP helper clears its timer once response headers arrive; the generic handler reads error bodies with response.text() before truncating their text. action-engine.ts logs, persists, and returns handler error messages before the successful response sanitization path.

These are source-level observations, not demonstrated production exploitation. The old docs/security-remediation-plan.md marks relevant work landed, so verify actual behavior instead of using its status labels as proof. Inspect current code and tests, reproduce each hypothesis through the real action path, and record disproved hypotheses without inventing defects.

Workstream 1: outbound destination enforcement

- Establish the supported destination policy for generic HTTP actions and inventory affected consumers of the SSRF and HTTP helpers.
- Validate the final templated URL, scheme, hostname, and resolved address set. Cover IPv4, IPv6, IPv4-mapped IPv6 in equivalent representations, metadata/loopback/private destinations, mixed public/private answers, malformed URLs, and empty or failing DNS answers.
- Bind the actual connection to validated addresses so a second resolution cannot substitute a forbidden destination. Preserve TLS certificate verification, hostname/SNI behavior, and supported public HTTP/HTTPS use. Do not disable TLS verification or install a global permissive resolver/dispatcher.
- Define and enforce redirect behavior. Either reject redirects with an actionable error or validate and pin every allowed hop, with a finite hop limit. Never forward credentials to a different origin. Test both standard authorization and configured custom secret-bearing headers. Document any intentional compatibility change.
- Use deterministic local fixtures and injectable DNS/transport seams to demonstrate the pre-fix defect and corrected behavior. A mocked guard returning false is not proof that the actual transport enforces destination policy. Include evidence that forbidden connection attempts and credential-bearing redirected requests never occur, plus a legitimate request that still succeeds.

Workstream 2: bounded request and response handling

- Apply a bounded deadline across DNS, connection, redirects, headers, and body consumption. A response that sends headers and then stalls must terminate. Preserve caller cancellation and cancel/release bodies, sockets, timers, and transport resources on completion and failure.
- Bound bytes actually consumed for successful and error responses; enforce limits for streamed/chunked bodies and missing, inaccurate, or oversized Content-Length. Do not allocate an unlimited error body and then truncate it. Apply limits to decoded content where transport decompression is supported.
- Retain existing response parsing, field selection, and action timeout semantics where compatible with these guarantees. Make malformed JSON, empty supported responses, oversized errors, slow bodies, and disconnects produce useful bounded failures.
- Add a fixed local fixture matrix for delayed headers, stalled body, slow chunks, oversized success, oversized error, and abort during consumption. Define timing tolerances and byte limits before measuring; record observed termination and cleanup. Use fake timers where appropriate and focused real local transport checks where mocks cannot prove behavior.
- Inspect every caller of any changed shared helper. Run affected GitHub/ADO/Azure and generic action regressions locally without issuing real provider actions. Do not introduce automatic retries of mutating requests.

Workstream 3: safe error, log, and audit handling

- Trace upstream failures from HTTP handlers through action-engine responses, logger output, audit persistence, and the agent-visible tool result. Check failure paths, not only successful response sanitization.
- Use synthetic secret sentinels to reproduce any leaks through upstream bodies, URLs/query parameters, authorization/custom headers, nested error causes, and raw serialized error objects. Do not inspect or use real credentials for these tests.
- Ensure sensitive content is removed before it reaches each sink. Preserve bounded diagnostic categories, HTTP status, action identity, and safe correlation information so operators can still investigate. Sanitize or quarantine untrusted upstream error content according to the existing policy; do not present it as trusted instructions.
- Keep audit integrity and append-only behavior intact. Do not rewrite historical audit rows or relabel an unsanitized failure as sanitized. Align response sanitization/quarantine metadata with what actually occurred.
- Add regressions that capture actual logger output, persisted audit records, and returned action/tool responses. Assert synthetic secrets are absent from all applicable sinks while useful diagnostics remain. Preserve action approval and allowed-resource denials, with zero handler side effects on denied requests.

Workstream 4: integration, review, and completion evidence

- Maintain docs/analysis/2026-09-07/action-security/execution/plan.md, acceptance.json, progress.md, and a receipts/ directory. Map every required outcome to its finding, reproduction, changed paths, regression coverage, exact tested source identity, result, and any remaining prerequisite.
- Use explicit acceptance states such as not-run, reproduced, fixed, verified, disproved, and blocked. A disproved hypothesis closes a proposed defect only when evidence also establishes the underlying required behavior. Skips and unavailable infrastructure remain visible.
- For demonstrated bugs, show a desired-behavior test failing for the relevant reason on the baseline, then passing after the fix. Add meaningful boundary/integration tests rather than tests that merely mirror helper implementation.
- Run affected suites after each coherent change and the required ./scripts/validate.sh pipeline on the final source. Use npx pnpm as required by the repository. Record any pre-existing failures precisely; do not call a failed or unexecuted pipeline green.
- Verify the action path through the existing integration harness and actual local HTTP/TLS fixtures where needed. Keep test bypasses dependency-injected and inaccessible to production request inputs. Use task-owned temporary resources and ephemeral ports, and clean up only resources created by this task.
- Review the final diff for policy bypasses, credential leakage, transport/TLS regressions, resource leaks, compatibility changes, and concurrent-task overlap. Resolve demonstrated issues within scope and repeat checks only where changes or remaining concerns justify it.
- Commit coherent validated changes locally, staging only intended paths. Record baseline and tested commits, dirty-tree state where relevant, and commit order. Do not claim compatibility with the other task's future merged result unless that combined source was actually tested.
- Produce execution/closure.md with criterion-by-criterion results, commands and receipts, behavior changes, residual risks, integration notes, and any smallest remaining external validation step. Keep local proof distinct from CI, deployed behavior, and provider acceptance.

Execution authority and boundaries

Once this prompt is activated, proceed autonomously in this task with local implementation, tests, local HTTP/TLS simulations, documentation, read-only repository/task inspection, normal development dependencies, and scoped local commits. Use synthetic credentials and controlled fixtures. Complete routine implementation decisions without repeated permission questions.

Do not dispatch Autopod pods, create additional tasks, or send messages to other tasks or people. Do not probe production/private infrastructure or cloud metadata services to demonstrate an exploit. Do not mutate live pods, restart/deploy the daemon, change cloud resources, use paid provider canaries, change models/accounts, consume usage resets, push branches, publish PRs, or merge without separate explicit user authorization. These external actions are not required for this local implementation goal.

If a prerequisite or approval blocks one criterion, record the exact blocker and finish independent authorized work. Do not treat elapsed time as approval or a partial checkpoint as completion. Keep progress durable across turns and resume from the ledger instead of repeating completed work. Follow the Goal system's status rules; never mark the goal complete while required local implementation or verification remains outstanding.

Definition of done

All four workstreams satisfy their required outcomes through current evidence; demonstrated defects have fixes and regressions; legitimate action behavior remains covered; the required pipeline passes on identified final source; scoped commits and closure evidence are reviewable; and concurrent work is preserved. No required criterion is silently dropped. Any optional deployed/provider follow-up is clearly separated from the completed local deliverable. Time spent, a written plan, or a green helper-only suite is not sufficient.
