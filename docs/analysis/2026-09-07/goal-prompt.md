/goal Implement and validate the entire Autopod improvement plan in /Users/ewi/repos/autopod/docs/analysis/2026-09-07/report.md. Continue through all six workstreams until their acceptance criteria are demonstrably satisfied, or the remaining work requires a specific external prerequisite or approval. This is an implementation goal, not another analysis or planning exercise.

Objective and evidence

Make Autopod reliably preserve work and human decisions, prevent avoidable retries and stale dispatches, report truthful outcomes and cost, and support dependable unattended scanning and recovery. Use the report, evidence.json, commits.txt, summarize.py, and diagnostics.test.ts in the same directory as the starting evidence. Treat the historical snapshot as dated evidence, not current production state. Verify current code, branch state, and relevant live read-only evidence before acting on each finding. Investigate the actual cause of the broad history/cost API failures; the malformed-JSON fixture demonstrates a possible failure mechanism, not a proven production diagnosis.

Create a durable implementation plan and acceptance ledger under docs/analysis/2026-09-07/execution/. Map every recommendation and acceptance criterion to its implementation, regression test, evidence, and remaining prerequisites. Reorder work to respect dependencies, but do not silently drop or substitute workstreams. If a hypothesis is disproved, record the evidence and implement the smallest supported solution to the underlying requirement.

Required outcomes

1. Completion, escalation, recovery, and delivery
- Reconcile agent settlement with outstanding human input before finalization. Preserve summaries and work across disconnected or expired MCP waits, late replies, duplicate completion events, and daemon restarts.
- Keep unanswered decisions actionable. Never permit implicit approval or weaken the awaiting_input transition guard to hide the defect.
- Make finalization decisions durable and side effects idempotent. Distinguish agent completion, source preservation, validation, delivery, and external disposition.
- Extract completion/escalation, provider recovery, and delivery responsibilities into cohesive modules as needed to establish these guarantees. Preserve the existing daemon/SQLite architecture and lifecycle-generation protections.

2. Task-wide retries, budgets, and evidence reuse
- Persist retry identity and cumulative accounting across Resume, restart, and linked fix pods. Separate transient infrastructure/provider failures from repository rework.
- Require changed relevant conditions or a recorded authorized override before repeating an unchanged nonretryable failure. Use bounded backoff for genuinely transient failures without silently changing provider/account/model.
- Account for initial work, rework, review, validation time, and available infrastructure cost without double counting or inventing missing measurements.
- Reuse successful validation evidence only when the source tree, contract, toolchain, commands, dependencies, environment, and validation implementation match. Missing identity invalidates reuse. Preserve review finding ledgers and substantive gates.

3. Dispatch and environment preflight
- After fresh remote refs are established, check contract create/update/delete declarations against the actual base, equivalent active/recent work, required commands, resource requirements, and provider binding before starting a coding agent.
- Existing artifacts trigger stale-contract review, not automatic acceptance. Support explicit intentional reruns with distinct execution identity.
- Resolve the demonstrated sandbox ownership/config capability problem and invalid registry probe through supported capability checks and correct execution semantics.
- Preserve authorized provider identity across mutable profile changes; provide actionable reconciliation errors rather than silent rebinding.

4. Truthful metrics, history, and operator views
- Separate logical tasks, pods, provider attempts, validation executions, and delivery receipts. Never label completed worker attempts as delivered PRs.
- Distinguish executed pass/fail, skipped, unavailable, waived, no-change, cancelled, externally completed, and unresolved results. Define first-pass and delivery denominators explicitly.
- Reconcile latest validation, durable history, human waivers, and delivery evidence without rewriting historical failures as successes.
- Repair history/cost API availability using the proven root cause; use bounded projections and useful per-record diagnostics. Reconcile task-level and phase-level totals with explicit telemetry completeness.
- Update affected daemon APIs, shared contracts, CLI, desktop, and mobile views wherever they expose changed behavior. Backend-only completion is insufficient for an operator-facing requirement.

5. Scheduled scans and durable triage
- Separate versioned deterministic collection from bounded agent judgment. Keep the exact requested delta scope; empty deltas must not widen it.
- Incomplete scanner execution must not report a clean result. Preserve stable finding identities and unresolved findings across runs.
- Persist reports and human triage independently of worker lifetime. Disconnection must not lose findings or fail report collection. Launch repairs only after the required human selection.
- Distinguish report-only completion from patch delivery; update the actual scheduling and operator paths, not just an unused helper.

6. Release, environment, and backup provenance
- Record daemon SHA, runtime CLI version, image digest, contract/validation identity, and relevant capabilities per execution. Surface meaningful release/readiness information through health and operator views.
- Verify backup scope and data freshness against the intended active database. Add freshness/headroom checks and an isolated restore verification path while preserving existing deployment/cleanup safeguards.
- Do not infer that all hosted backups are missing from the stale local backup observed in the report.

Historical fixes and constraints

Retain and regression-test the existing strict remote-fetch gate, validation-only recovery, bounded reviewer execution, frozen finding/closure ledgers, stable validation history sequences, Codex transport/OAuth fixes, ADO tenant authentication, and guarded deployment tooling. Check whether each relevant fix is deployed; do not reimplement an already-satisfied requirement. Do not change the default model based on the confounded historical leaderboard, replace the architecture wholesale, weaken security/approval gates, discard substantive findings, or manufacture performance gains by reducing validation coverage.

Execution and authority

Work in this Codex task. Preserve unrelated staged, tracked, and untracked work. Use an isolated codex/ branch/worktree when appropriate, and ensure it contains the report and supporting artifacts, which may be uncommitted in the original checkout. Follow applicable AGENTS.md instructions and required profile/state change checklists. Check migration numbering against current branches and verify upgrades from representative existing databases.

Proceed autonomously with local implementation, tests, local simulations, documentation, reversible development-environment work, read-only live inspection, and scoped local commits. Do not pause for routine implementation decisions or stop after one milestone. Do not dispatch Autopod implementation pods as a substitute for completing this work here.

Production deployment/restarts, live pod lifecycle mutations, paid provider/sandbox canaries, cloud resource changes, pushes/PR publication/merges, and external messages require explicit session authorization. Prepare the concrete diff, release/rollback procedure, target identities, test/canary scope, and estimated spend before asking for any missing authorization. Continue independent local work while a gate is pending. Approval is not implied by elapsed time. Never treat pending live verification as PASS or mark the whole goal complete while required acceptance remains outstanding.

Validation and completion

First turn the current diagnostic characterizations into reproductions of desired behavior: demonstrate the defect, implement the fix, then prove the corrected behavior. Do not retain assertions that deliberately expect the bug as evidence of success. Add meaningful integration and fault-injection tests for the actual lifecycle paths, not only helper functions or transition tables.

Cover restart/disconnect/duplicate-event ordering, exactly-once logical delivery accounting, malformed legacy rows, validation-cache invalidation, retry budget persistence, stale contracts, provider profile changes, empty scan deltas, incomplete scans, durable triage, migration compatibility, and backup restoration. Run affected suites and the repository's required validation pipeline. Verify changed desktop/mobile/CLI flows on their supported surfaces; source compilation alone is not interaction proof.

Build a reproducible matched benchmark with fixed tasks, source, environment, and validation coverage. Test whether repeated validation time can be reduced by at least 25% without additional escaped seeded defects or weakened authority. Label local replay results separately from live workload results. If the target is unsupported or unachievable, document the measured limit and tradeoff rather than changing the denominator. Any paid live comparison requires the bounded approval described above.

The goal is complete only when all six workstreams are implemented or shown already satisfied by current evidence, required checks pass, operator flows are verified, and every required acceptance claim has the appropriate proof. An unrun test, unavailable platform, pending deployment, or unauthorized canary is an outstanding requirement, not completion. Produce a final closure report with the acceptance ledger, changed code, exact tested commits, test receipts, measured outcomes, deployment/live evidence where authorized, and residual risks.

At each checkpoint, record what changed, what the evidence proves, and the next unfinished criterion. Continue from that state across turns. If progress is genuinely blocked after reasonable alternatives, finish all independent work, preserve the partial implementation, and report the exact remaining blocker and smallest action needed to proceed. A budget limit, summary, draft PR, or partial milestone is not achievement of the goal.


Approved amendment — 2026-09-10

The user explicitly approved this precise amendment to the historical history/cost failure-causality requirement (W4.5):

> September 7 history/cost failure cause remains unknown because the required logs were not retained; current API behavior is verified.

This amendment supersedes only the requirement to establish the September 7 historical cause before closure. Retain the unknown cause as a disclosed limitation; do not claim retrospective diagnosis or turn malformed-JSON fixtures into causal proof. All current API, implementation, regression, operator, deployment and other acceptance requirements remain in force. The original contract above and earlier failed/partial receipts remain historical evidence. Approval and scope are recorded in [checkpoint 137](execution/checkpoint-137.md) and its [approval receipt](execution/receipts/checkpoint-137-user-amendment.json).
