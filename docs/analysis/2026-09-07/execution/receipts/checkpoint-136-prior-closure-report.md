# Partial closure report

Current checkpoint: [135](checkpoint-135.md). All six workstreams have implementation and mapped evidence. The ledger now has 37 verified criteria and six partial criteria. Whole-goal completion is not claimed.

Production runs clean release `089442b63e5827894da40c91c764b47ff4562073`, PID 136112, schema 183. Exact loaded health identity, service cwd/current link, fresh all-table backup/isolated restore and database integrity/FKs are verified. The receiver crash fix survived its real failure condition with zero daemon restarts. [Hosted deployment and acceptance](checkpoint-134.md).

The next published candidate is `425ff91cd5e6347b32d21b69804ea4c02008bc8e` on `codex/durable-execution-contract`. Main remains integrated and unchanged at `b75fbf0b7e2c4ea455838a6e4df6537665a7a8cc`. Full validation passes: 6,390 package tests, one existing platform skip,11 standalone Node tests and required shell/install/build/type/lint/audit/secret checks;8/15 test tasks cached and one moderate advisory. [Exact validation receipt](receipts/checkpoint-135-full-validation-identity.json). Staging of this candidate is in progress; it is not the current deployed release.

CP135 fixes two live-discovered gaps. The create schema discarded numeric tokenBudget, so earlier canary requests were effectively unlimited despite their recorded requested 32,000. The corrected schema retains validated numeric limits and preserves established omission/profile inheritance and explicit-null/unlimited behavior. Sandbox imports now use the resolved immutable digest and execution provenance verifies the fresh sandbox-to-disk link, immutable source and managed digest label. Existing mutable imports retain unavailable provenance; historical labels are not turned into proof.

The MCP smoke is still open. `middle-tahr` made one real summary call which failed HTTP transport; its failure and no-change checkpoint are retained. Recorded model cost is $0.068994, with infrastructure and actual billing unavailable. A same-image non-model network probe passed HTTP/1.1 and HTTP/2 and was deleted. The explicit retry `crooked-spider` encountered Azure empty403 before CLI readiness, used bounded infrastructure cooldown, and was stopped; both of its sandboxes are confirmed absent. Zero recorded retry tokens/cost is not verified zero billing. [Retry and fixes](checkpoint-135.md).

All original automatic dispatch settings are restored with pendingOperations=0, including the overdue schedule's existing catch-up decision and unchanged Podsitter provider authorization. All named canary sandboxes in CP133–135 are confirmed absent; shared production disk images were retained. One CP133 cleanup exceeded its ten-minute resource target and remains recorded as such. CP134 and 135 cleanup occurred within their bounds.

| Workstream | Verified evidence | Outstanding acceptance |
|---|---|---|
| 1. Completion, decisions, delivery | Durable manager/MCP fault regressions, native decision/recovery flows, deployed source and live crash containment. | Successful hosted sandbox MCP summary smoke. |
| 2. Retries, budgets, evidence reuse | Durable retry identity/cooldown/binding, exact evidence reuse, frozen reviews, truthful cost completeness and supported client interactions. | Deploy numeric create-budget correction and verify effective served/task limit. |
| 3. Dispatch and environment | Fresh refs/base checks, explicit distinct reruns, frozen provider identity, CP131 actual image config/registry/resource/streaming capabilities. | Deploy and verify corrected immutable-image admission/provenance. |
| 4. Metrics, history, views | Bounded live history, cost/phase reconciliation, distinct units and recorded delivery, retained failures/waivers, mapped native/CLI/mobile interactions. | Actual September 7 historical failure cause remains unknown; a separately retained request-correlated trace is required. |
| 5. Scheduled scans and triage | Exact-window collection, empty/incomplete distinction, durable reports/findings and human-selected repair paths, supported interactions. | None within recorded required scope. |
| 6. Release and backups | Exact clean loaded source, actual fresh stopped-source backup/isolated restore, schema 153→183 upgrade and unchanged183 lineage, integrity/FKs, readiness views. | Actual corrected immutable-image execution provenance. |

Prior 357 Swift tests and mapped native/mobile/CLI interactions retain their exact source boundaries. CP135 changes shared request parsing and a type comment, not client UI implementation. The matched local benchmark remains613.435166ms baseline versus1764.543375ms reuse, with zero escaped seeded defects and unchanged coverage. The 25% target is unsupported; no live speed gain is claimed.

The historical failure trace is separate from all new incidents. Retained pre-report journal is empty; current syslog did not contain the failing requests and the fully read older archive ends August 23. Neither a malformed-JSON fixture nor current HTTP200 establishes the old cause. The original contract remains unchanged.

The user's continuing authorization covers publication, controlled deployment/restart, dispatch pause/restore, fresh backup verification and necessary canaries. There is no routine approval pending. The [release procedure](release-and-acceptance-packet.md) preserves post-cutover DB/WAL, requires zero active work and a fresh restore-verified snapshot, and uses forward recovery. A bare downgrade to the schema 153 writer is not a safe rollback.

The [ledger](acceptance.json) maps all 43 criteria and retains earlier implementation/test evidence. [Dated prior closure](receipts/checkpoint-134-prior-closure-report.md) preserves the earlier unpublished/unattested state; its old gate wording is historical.

## Criterion status

| Criterion | Requirement | Status |
|---|---|---|
| W1.1 | Settlement and unresolved human input are reconciled without weakening transitions | verified |
| W1.2 | Summaries and work survive disconnect, expiry, late replies, duplicate completion and restart | partial |
| W1.3 | Finalization decisions and generations are durable with idempotent side effects | verified |
| W1.4 | Agent settlement, source preservation, validation, delivery and external disposition are separate | verified |
| W1.5 | Completion/escalation, provider recovery and delivery have cohesive ownership | verified |
| W2.1 | Task retry identity and cumulative budget survive Resume, restart and linked fix pods | partial |
| W2.2 | Unchanged nonretryable failures require changed relevant inputs or recorded authorized override | verified |
| W2.3 | Transient provider failures use bounded backoff within authorized binding separately from repository rework | verified |
| W2.4 | Initial, rework, review, validation time and available infrastructure costs reconcile without double counting | verified |
| W2.5 | Validation reuse requires complete matching tree, contract, toolchain, commands, dependencies, environment and implementation identity | verified |
| W2.6 | Frozen review finding and closure ledgers and substantive gates are retained | verified |
| W2.7 | Matched reproducible benchmark measures 25 percent target and seeded defect escape with fixed coverage; local and live separated | verified |
| W3.1 | Fresh remote refs precede actual-base create/update/delete contract checks | verified |
| W3.2 | Equivalent active/recent work is detected; intentional reruns receive distinct execution identity | verified |
| W3.3 | Required commands, resources and provider binding checked before coding agent spawn | partial |
| W3.4 | Supported capability probe resolves sandbox config ownership and registry execution semantics | verified |
| W3.5 | Queued provider binding survives mutable profile changes with actionable reconciliation errors | verified |
| W3.6 | Live actual-image capability canary verified under explicit authority | verified |
| W4.1 | Logical tasks, pods, provider attempts, validation executions and delivery receipts have distinct units | verified |
| W4.2 | Executed pass/fail, skipped, unavailable, waived, no-change, cancelled, external and unresolved outcomes remain explicit | verified |
| W4.3 | First-pass and delivery denominators require evidence; one logical delivery counts once | verified |
| W4.4 | Latest validation, history, waivers and delivery reconcile without rewriting failures | verified |
| W4.5 | Live broad history/cost API root cause proven before claiming production repair | partial |
| W4.6 | Bounded projections and per-record diagnostics preserve healthy rows with malformed legacy records and realistic payload sizes | verified |
| W4.7 | Task/phase/attempt cost totals reconcile with explicit telemetry completeness | verified |
| W4.8 | Affected APIs, shared contracts, CLI, desktop and mobile updated and interactions verified | verified |
| W5.1 | Versioned deterministic stack/delta/scanner collection precedes bounded agent judgment in actual scheduling path | verified |
| W5.2 | Exact delta preserved and empty delta never widened | verified |
| W5.3 | Incomplete scanner execution cannot report clean | verified |
| W5.4 | Stable finding identities preserve unresolved findings across runs without duplicate prompts | verified |
| W5.5 | Reports and triage survive worker lifetime and disconnected human wait | verified |
| W5.6 | Repairs launch only after required human selection; report-only completion differs from patch delivery | verified |
| W6.1 | Execution records contain daemon SHA, CLI version, image digest, contract/validation identity and capabilities | partial |
| W6.2 | Health and operator release/readiness views identify meaningful release and failure provenance | verified |
| W6.3 | Active hosted database and backup scope verified without inferring all hosted backups missing | verified |
| W6.4 | Freshness and disk headroom checks added while preserving cleanup/deployment safeguards | verified |
| W6.5 | Sampled backup restores in isolation with freshness and integrity verification | verified |
| G.1 | Historical strict fetch, validation-only recovery, bounded review, ledgers, history sequences, Codex transport/OAuth, ADO auth and guarded deployment retain regression coverage and deployment status evidence | verified |
| G.2 | Migration numbering checked against current branches and representative prior database upgrades verified | verified |
| G.3 | All affected suites and full repository validation pipeline pass on exact recorded commits | verified |
| G.4 | Desktop/mobile/CLI supported-surface interactions verified; compilation alone is insufficient | verified |
| G.5 | Deployment/rollback identities, canary scope and spend prepared before requesting gated actions | verified |
| G.6 | Final closure maps every recommendation to implementation/tests/evidence/prerequisites; no unverified acceptance treated as PASS | partial |
