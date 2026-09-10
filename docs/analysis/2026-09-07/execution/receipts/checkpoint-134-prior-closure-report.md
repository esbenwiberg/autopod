# Partial closure report

Current checkpoint: [132](checkpoint-132.md). All six workstreams have local implementation and regression evidence. Required native/CLI/mobile interactions, hosted snapshot upgrade compatibility and actual-image capability canaries are verified within their recorded scopes. The goal remains incomplete: hosted loaded/rollback source, deployment acceptance and the actual historical API failure cause remain outstanding.

## Current candidate

Release candidate is `feeb55d6d9bed010b23a37cf18d2c597da2df408`; application packages are byte-identical to canary source `9abf64b1d199f71f79190b6fc667d899fdc1559e`, on isolated branch `codex/durable-execution-contract`. Current remote main remains integrated `b75fbf0b7e2c4ea455838a6e4df6537665a7a8cc`. The [394-path code patch](receipts/checkpoint-131-candidate-code.diff) and [blob manifest](receipts/checkpoint-131-candidate-manifest.json) cover all changed non-documentation paths. Nothing was published or deployed by this goal execution.

The latest correction makes sandbox resource metadata work when the VM has no cgroup limits. It reads a fresh, ID-matched Running sandbox allocation and retains any stricter guest limit. The desired-behavior test failed before the fix; 117 affected tests passed afterward. The final actual-image canary observed old null limits and corrected 2 CPUs / 4 GiB on the same sandbox. [Live before/after](receipts/checkpoint-131-resource-capability.json).

The prior 357 Swift tests, native/CLI/mobile interactions, actual snapshot 153→183 upgrade and NuGet-validator proof remain tied to their exact earlier sources: [unchanged-source comparison](receipts/checkpoint-131-source-identity.json). The [final full pipeline](receipts/checkpoint-131-full-validation-identity.json) passes: 6,375 package tests, one existing platform skip, 11 standalone Node tests and all required build/type/lint/audit/secret checks. The first run failed fixture lint only; exact executed inputs were preserved before formatting maintained copies, without changing validation rules.

CP132 adds an opt-in exact release identity gate to deployment. Its regression suite and the [full required pipeline](receipts/checkpoint-132-full-validation-identity.json) pass on the clean candidate. The [updated 396-path manifest](receipts/checkpoint-132-candidate-manifest.json) binds the prior full patch plus the two-file deployment guard diff. Hosted inspection now establishes clean on-disk `ca92847a`, matching service/current directory, schema 153 and zero active/queued pods at observation time; loaded bytes remain unattested.

## Required capability canaries

The user supplied [continuing authorization](canary-authorization.md). Codex upload ownership was root `0:0:644`; actual exec and installed configs were UID/GID 1000. Sentinel A→B atomic replacements produced distinct inodes and exact content. The actual streaming implementation verified UID, latest content, separate stdout/stderr and exit 0. Codex CLI is 0.144.4 and Node v22.23.2 on the pinned dataverse-harness digest.

The separate pinned Teamplanner image passed the actual candidate registry validator: supported source-list, help and public-feed package-search with successful JSON validation. [NuGet evidence](receipts/checkpoint-131-nuget-capability.json). This proves command semantics on the real image; it does not claim historical private-feed authentication or a change to the profile's execution target.

Every created sandbox and image in these four CP131 runs was deleted and GET404 verified. No model/provider calls, package installation, role change, existing-pod mutation or deployment ran. The known compute-plus-transfer estimates sum to about $0.26; actual billing and ancillary conversion/storage/retry costs remain unavailable. Earlier failed/timed-out attempts retain their original boundaries.

## Six-workstream disposition

| Workstream | Verified implementation and evidence | Outstanding acceptance |
|---|---|---|
| 1. Completion, decisions and delivery | Durable completion/guidance/source/delivery/ownership paths; actual manager/MCP restart/duplicate/disconnect faults; native decision and recovery flows. | Current hosted loaded source; trustworthy original identity/observed exit for any specific live unresolved claim. |
| 2. Task retries, accounting and evidence reuse | Persistent budgets and binding; complete-input evidence reuse; frozen reviews; cost missingness; native retries and waivers. | Deployed provenance. Historical missing billing stays unavailable. |
| 3. Dispatch and environment | Fresh refs/base declarations, equivalent-work/rerun identity, provider/resource/command admission, actual Codex ownership/config/streaming, Teamplanner NuGet semantics and live resource-adapter correction. | Hosted provenance for deployment of the implemented dispatch paths. Required capability canaries are complete. |
| 4. Metrics, history and views | Distinct units/denominators, retained histories and waivers, bounded malformed-row projections, telemetry and supported operator interactions. | Actual historical failing history/cost request trace and cause; current successful responses do not establish that cause. |
| 5. Scheduled collection and triage | Actual scheduler exact-window collection, empty/incomplete distinctions, durable findings/reports, human-selected repairs and native policy/triage. | None within required recorded local/supported-surface scope. |
| 6. Release and backup provenance | Per-execution/readiness fields, actual runtime capabilities, freshness/headroom/restore tooling, representative upgrades, actual hosted snapshot candidate upgrade and native provenance views. | Hosted loaded/rollback source and deployment acceptance; fresh cutover backup if deployment is authorized. |

The matched local benchmark remains 613.435166 ms baseline versus 1,764.543375 ms reuse, with zero escaped seeded defects and unchanged coverage. The 25% target is unsupported on this fixture; no live speed gain is claimed.

## Remaining boundaries

Public health again returned 200 without release metadata at CP131. Service directory and on-disk Git metadata do not attest loaded JavaScript. The existing hosted snapshot upgrade proof remains valid on unchanged migration/backup source; it does not replace a fresh future cutover backup.

The bounded historical journal read found disk-full and other errors without correlation to the original failed history/cost requests. CP132 additionally found no retained pre-report journal and no failing HTTP trace in the current syslog; the completely read older archive ends August 23. A separately retained request-correlated trace is needed for that causal claim. No additional canary can reconstruct absent historical causality.

Publication/deployment/restart authority is separate from canary authority. The [release packet](release-and-acceptance-packet.md) retains pinned VM/database, drain, immutable full-build, backup/headroom and forward-recovery/rollback constraints; it must not be treated as an executable cutover until source and rollback prerequisites are satisfied. The source is local only.

The [acceptance ledger](acceptance.json) maps all 43 criteria. Earlier closure narrative is retained as [dated history](receipts/checkpoint-131-prior-closure-report.md). Raw executed canary inputs and replay instructions are preserved in the [immutable input archive](receipts/checkpoint-131-executed-inputs/README.md); historical runner/contract hashes resolve to those exact bytes, not subsequently formatted maintained copies.

## Criterion status

| Criterion | Requirement | Status |
|---|---|---|
| W1.1 | Settlement and unresolved human input are reconciled without weakening transitions | partial |
| W1.2 | Summaries and work survive disconnect, expiry, late replies, duplicate completion and restart | partial |
| W1.3 | Finalization decisions and generations are durable with idempotent side effects | partial |
| W1.4 | Agent settlement, source preservation, validation, delivery and external disposition are separate | partial |
| W1.5 | Completion/escalation, provider recovery and delivery have cohesive ownership | partial |
| W2.1 | Task retry identity and cumulative budget survive Resume, restart and linked fix pods | partial |
| W2.2 | Unchanged nonretryable failures require changed relevant inputs or recorded authorized override | partial |
| W2.3 | Transient provider failures use bounded backoff within authorized binding separately from repository rework | partial |
| W2.4 | Initial, rework, review, validation time and available infrastructure costs reconcile without double counting | partial |
| W2.5 | Validation reuse requires complete matching tree, contract, toolchain, commands, dependencies, environment and implementation identity | verified |
| W2.6 | Frozen review finding and closure ledgers and substantive gates are retained | partial |
| W2.7 | Matched reproducible benchmark measures 25 percent target and seeded defect escape with fixed coverage; local and live separated | verified |
| W3.1 | Fresh remote refs precede actual-base create/update/delete contract checks | partial |
| W3.2 | Equivalent active/recent work is detected; intentional reruns receive distinct execution identity | partial |
| W3.3 | Required commands, resources and provider binding checked before coding agent spawn | partial |
| W3.4 | Supported capability probe resolves sandbox config ownership and registry execution semantics | verified |
| W3.5 | Queued provider binding survives mutable profile changes with actionable reconciliation errors | partial |
| W3.6 | Live actual-image capability canary verified under explicit authority | verified |
| W4.1 | Logical tasks, pods, provider attempts, validation executions and delivery receipts have distinct units | partial |
| W4.2 | Executed pass/fail, skipped, unavailable, waived, no-change, cancelled, external and unresolved outcomes remain explicit | partial |
| W4.3 | First-pass and delivery denominators require evidence; one logical delivery counts once | partial |
| W4.4 | Latest validation, history, waivers and delivery reconcile without rewriting failures | partial |
| W4.5 | Live broad history/cost API root cause proven before claiming production repair | partial |
| W4.6 | Bounded projections and per-record diagnostics preserve healthy rows with malformed legacy records and realistic payload sizes | partial |
| W4.7 | Task/phase/attempt cost totals reconcile with explicit telemetry completeness | partial |
| W4.8 | Affected APIs, shared contracts, CLI, desktop and mobile updated and interactions verified | verified |
| W5.1 | Versioned deterministic stack/delta/scanner collection precedes bounded agent judgment in actual scheduling path | verified |
| W5.2 | Exact delta preserved and empty delta never widened | verified |
| W5.3 | Incomplete scanner execution cannot report clean | verified |
| W5.4 | Stable finding identities preserve unresolved findings across runs without duplicate prompts | verified |
| W5.5 | Reports and triage survive worker lifetime and disconnected human wait | verified |
| W5.6 | Repairs launch only after required human selection; report-only completion differs from patch delivery | verified |
| W6.1 | Execution records contain daemon SHA, CLI version, image digest, contract/validation identity and capabilities | partial |
| W6.2 | Health and operator release/readiness views identify meaningful release and failure provenance | partial |
| W6.3 | Active hosted database and backup scope verified without inferring all hosted backups missing | verified |
| W6.4 | Freshness and disk headroom checks added while preserving cleanup/deployment safeguards | verified |
| W6.5 | Sampled backup restores in isolation with freshness and integrity verification | verified |
| G.1 | Historical strict fetch, validation-only recovery, bounded review, ledgers, history sequences, Codex transport/OAuth, ADO auth and guarded deployment retain regression coverage and deployment status evidence | partial |
| G.2 | Migration numbering checked against current branches and representative prior database upgrades verified | verified |
| G.3 | All affected suites and full repository validation pipeline pass on exact recorded commits | verified |
| G.4 | Desktop/mobile/CLI supported-surface interactions verified; compilation alone is insufficient | verified |
| G.5 | Deployment/rollback identities, canary scope and spend prepared before requesting gated actions | partial |
| G.6 | Final closure maps every recommendation to implementation/tests/evidence/prerequisites; no unverified acceptance treated as PASS | partial |
