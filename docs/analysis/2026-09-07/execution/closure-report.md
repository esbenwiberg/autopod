# Final closure report

Current checkpoint: [137](checkpoint-137.md). The goal is complete under the explicitly amended contract. All six workstreams have implementation and mapped evidence: 42 criteria are verified, and W4.5 is accepted with the user-approved historical-causality amendment. No required acceptance remains outstanding. The historical cause remains unknown and is not labeled verified. [Exact approval and scope](receipts/checkpoint-137-user-amendment.json).

The final CP136 hosted inspection verified clean release `425ff91cd5e6347b32d21b69804ea4c02008bc8e`, PID 157498, schema 183. Exact loaded health identity, process cwd/current link, fresh all-table backup and isolated restore, database integrity/FKs and zero service restarts through the smoke are verified. [Hosted rollout and final acceptance](checkpoint-136.md), [final process/database](receipts/checkpoint-136-final-post-inspect.json).

The required pipeline passed on that exact product source: 6,390 package tests, one existing platform skip, 11 standalone Node tests and required shell/install/build/type/lint/audit/secret checks; 8/15 test tasks were cached and one moderate dependency advisory remains. Full staging passed mandatory reviewer/browser prewarm and actual built-module semantic checks. The implementation branch is `codex/durable-execution-contract`; main remains integrated at `b75fbf0b7e2c4ea455838a6e4df6537665a7a8cc`, with no main merge performed. [Validation identity](receipts/checkpoint-135-full-validation-identity.json), [stage evidence](receipts/checkpoint-136-stage.txt).

The corrected create API retains numeric budgets and preserves omitted/profile-inherited and explicit-null/unlimited behavior. The hosted smoke confirmed 32,000 tokens in both the served pod and durable task ledger. Its one agent/provider attempt reported 46,313 tokens; the daemon paused with budgetCheck=exhausted and no further turn ran. This is accounting-boundary enforcement, not a hard in-flight token or dollar ceiling. Earlier canary budgets that the old schema discarded remain recorded as ineffective requests.

The same smoke durably registered its exact summary through MCP, preserved it after cleanup and recorded the deployed SHA, validation hash, Codex 0.144.4, immutable image digest, contract identity and actual 2 CPU / 4 GiB allocation. A separate non-model canary verified actual immutable image import and fresh sandbox-to-disk identity in 119,139 ms. Recorded smoke model cost is $0.063942; exact provider and infrastructure billing remain unavailable. No implementation, validation or delivery is claimed for this operational smoke. [MCP receipt and budget pause](receipts/checkpoint-136-canary-events.json), [durable summary/accounting](receipts/checkpoint-136-canary-observation.json), [image probe](receipts/checkpoint-136-image-probe-result.json).

Both CP136 canary sandboxes have provider GET404 proof within the ten-minute target. Two unrelated queued Dispatcher reservations were allowed to expire through their own watchdog and were observed terminal before restart; no operator kill was issued to them. All original automatic dispatch settings are restored with pendingOperations=0, preserving the concurrent advance to the future September 11 schedule and unchanged provider authorization. Shared production images and historical failed-canary records are retained. CP133's eleven-minute cleanup remains a recorded elapsed-bound failure. [Dispatch restoration](receipts/checkpoint-136-dispatch-retry-restore.json), [smoke cleanup](receipts/checkpoint-136-resource-cleanup.json).

| Workstream | Verified evidence | Outstanding acceptance |
|---|---|---|
| 1. Completion, decisions, delivery | Durable manager/MCP fault regressions, native decision/recovery flows, hosted summary persistence and crash containment. | None within recorded required scope. |
| 2. Retries, budgets, evidence reuse | Durable retry identity/cooldown/binding, exact evidence reuse, frozen reviews, current budget retention and pause, cost completeness and supported client interactions. | None within recorded required scope. |
| 3. Dispatch and environment | Fresh refs/base checks, explicit reruns, frozen binding, actual image configuration/registry/resource/streaming capabilities and immutable import. | None within recorded required scope. |
| 4. Metrics, history, views | Bounded hosted history, cost/phase reconciliation, distinct units/delivery, retained failures/waivers, native/CLI/mobile interactions. | None under the approved amendment; historical cause disclosed as unknown. |
| 5. Scheduled scans and triage | Exact-window collection, empty/incomplete distinction, durable reports/findings, human-selected repair paths and supported interactions. | None within recorded required scope. |
| 6. Release and backups | Exact clean loaded source and image/CLI provenance, fresh backup/isolated restore, prior schema 153-to-183 upgrade and current unchanged-183 lineage, integrity/FKs and readiness views. | None within recorded required scope. |

Prior 357 Swift tests and mapped native/mobile/CLI interactions retain their exact source boundaries. CP135 changed shared request parsing and a type comment, not the client UI implementation. The matched local benchmark remains 613.435166 ms baseline versus 1764.543375 ms reuse, with zero escaped seeded defects and unchanged coverage. The 25% target is unsupported; no live speed gain is claimed. [Complete criterion evidence](acceptance.json).

The historical cause remains unknown: pre-report journal is empty, inspected current syslog did not contain the failing requests, and the fully read older archive ends August 23. Neither the malformed-JSON fixture nor current healthy APIs proves that cause. The user explicitly approved accepting this limitation for W4.5. Current API verification remains required and is supported by CP136; all other acceptance requirements remain unchanged. [Contract amendment](../goal-prompt.md), [approval receipt](receipts/checkpoint-137-user-amendment.json).

The [release packet](release-and-acceptance-packet.md) records current identities, completed acceptance and forward-recovery safeguards. Preserve post-cutover database/WAL and new records; a bare downgrade to the old schema-153 writer is unsafe. Previous failed MCP transport and Azure403 receipts remain failures, with no claim that this successful rerun explains their causes. [Dated prior closure](receipts/checkpoint-136-prior-closure-report.md).

## Criterion status

| Criterion | Requirement | Status |
|---|---|---|
| W1.1 | Settlement and unresolved human input are reconciled without weakening transitions | verified |
| W1.2 | Summaries and work survive disconnect, expiry, late replies, duplicate completion and restart | verified |
| W1.3 | Finalization decisions and generations are durable with idempotent side effects | verified |
| W1.4 | Agent settlement, source preservation, validation, delivery and external disposition are separate | verified |
| W1.5 | Completion/escalation, provider recovery and delivery have cohesive ownership | verified |
| W2.1 | Task retry identity and cumulative budget survive Resume, restart and linked fix pods | verified |
| W2.2 | Unchanged nonretryable failures require changed relevant inputs or recorded authorized override | verified |
| W2.3 | Transient provider failures use bounded backoff within authorized binding separately from repository rework | verified |
| W2.4 | Initial, rework, review, validation time and available infrastructure costs reconcile without double counting | verified |
| W2.5 | Validation reuse requires complete matching tree, contract, toolchain, commands, dependencies, environment and implementation identity | verified |
| W2.6 | Frozen review finding and closure ledgers and substantive gates are retained | verified |
| W2.7 | Matched reproducible benchmark measures 25 percent target and seeded defect escape with fixed coverage; local and live separated | verified |
| W3.1 | Fresh remote refs precede actual-base create/update/delete contract checks | verified |
| W3.2 | Equivalent active/recent work is detected; intentional reruns receive distinct execution identity | verified |
| W3.3 | Required commands, resources and provider binding checked before coding agent spawn | verified |
| W3.4 | Supported capability probe resolves sandbox config ownership and registry execution semantics | verified |
| W3.5 | Queued provider binding survives mutable profile changes with actionable reconciliation errors | verified |
| W3.6 | Live actual-image capability canary verified under explicit authority | verified |
| W4.1 | Logical tasks, pods, provider attempts, validation executions and delivery receipts have distinct units | verified |
| W4.2 | Executed pass/fail, skipped, unavailable, waived, no-change, cancelled, external and unresolved outcomes remain explicit | verified |
| W4.3 | First-pass and delivery denominators require evidence; one logical delivery counts once | verified |
| W4.4 | Latest validation, history, waivers and delivery reconcile without rewriting failures | verified |
| W4.5 | September 7 history/cost failure cause remains unknown because the required logs were not retained; current API behavior is verified. | accepted_with_amendment |
| W4.6 | Bounded projections and per-record diagnostics preserve healthy rows with malformed legacy records and realistic payload sizes | verified |
| W4.7 | Task/phase/attempt cost totals reconcile with explicit telemetry completeness | verified |
| W4.8 | Affected APIs, shared contracts, CLI, desktop and mobile updated and interactions verified | verified |
| W5.1 | Versioned deterministic stack/delta/scanner collection precedes bounded agent judgment in actual scheduling path | verified |
| W5.2 | Exact delta preserved and empty delta never widened | verified |
| W5.3 | Incomplete scanner execution cannot report clean | verified |
| W5.4 | Stable finding identities preserve unresolved findings across runs without duplicate prompts | verified |
| W5.5 | Reports and triage survive worker lifetime and disconnected human wait | verified |
| W5.6 | Repairs launch only after required human selection; report-only completion differs from patch delivery | verified |
| W6.1 | Execution records contain daemon SHA, CLI version, image digest, contract/validation identity and capabilities | verified |
| W6.2 | Health and operator release/readiness views identify meaningful release and failure provenance | verified |
| W6.3 | Active hosted database and backup scope verified without inferring all hosted backups missing | verified |
| W6.4 | Freshness and disk headroom checks added while preserving cleanup/deployment safeguards | verified |
| W6.5 | Sampled backup restores in isolation with freshness and integrity verification | verified |
| G.1 | Historical strict fetch, validation-only recovery, bounded review, ledgers, history sequences, Codex transport/OAuth, ADO auth and guarded deployment retain regression coverage and deployment status evidence | verified |
| G.2 | Migration numbering checked against current branches and representative prior database upgrades verified | verified |
| G.3 | All affected suites and full repository validation pipeline pass on exact recorded commits | verified |
| G.4 | Desktop/mobile/CLI supported-surface interactions verified; compilation alone is insufficient | verified |
| G.5 | Deployment/rollback identities, canary scope and spend prepared before requesting gated actions | verified |
| G.6 | Final closure maps every recommendation to implementation/tests/evidence/prerequisites; no unverified acceptance treated as PASS | verified |
