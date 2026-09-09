# Partial closure report

Current update: [checkpoint 112](checkpoint-112.md) fixes native retry-card loading and corrects the synthetic HTTP fault injector. Four additional individual native interaction cases passed; expanded scan interaction remains unverified. Affected older mobile fault-response claims require renewed proof. [Checkpoint 111](checkpoint-111.md) records a clean full pipeline pass on `f55a04d6`; subsequent native changes require renewed full validation. The dated tables below do not supersede the current [acceptance ledger](acceptance.json). The goal remains incomplete.

Latest update: [checkpoint 110](checkpoint-110.md) fulfills the targeted hosted read, pins the affected sandbox image and records the release-label/dirty-checkout mismatch. Native UI interaction now works: a real failed-reply bug was reproduced and fixed. The application candidate has changed after the old 90a61141 packet; full validation and remaining native acceptance continue. No sandbox/role/publication/deployment authority is implied.

Latest update: [checkpoint 109](checkpoint-109.md) fulfills the approved runtime discovery, records the configured North Europe sandbox group, one profile image digest and historical disk-full errors, and documents the refused data-plane read. Ten-row API success does not prove broad-list availability. The next approval request is only section A of [targeted acceptance prerequisites](targeted-acceptance-prerequisites.md); access, actual-image canary and native acceptance remain separate. Earlier statements below are dated evidence.

Latest update: [checkpoint 108](checkpoint-108.md) records the approved successful on-VM sampled restore, matching active schema/watermark signatures, observed temporary-copy removal and four successful authenticated API reads. Those approval requests are fulfilled. Remaining runtime/canary discovery is prepared [separately](runtime-and-canary-discovery-packet.md); historical root cause, actual-image capability and visible native interaction are still outstanding. Earlier baseline sections below remain dated evidence.

Latest evidence: [checkpoint 107](checkpoint-107.md) records the approved successful guest inspection, verified active database and matching main migration-file manifest. Backup content/restore and loaded-runtime identities remain unverified. The next specific requests are in [the verification packet](next-verification-packet.md); the September 8 baseline below remains dated evidence.

All six workstreams have local implementations and regression evidence. Required current hosted provenance/root-cause evidence, actual-image capability acceptance, intended-database backup verification and visible native interaction remain outstanding. **The goal is not complete.**

The governing goal file is unchanged. [Acceptance ledger](acceptance.json) maps every one of 43 criteria to implementation, tests, evidence and current prerequisites. [Release and remaining acceptance packet](release-and-acceptance-packet.md) is the concrete next-action proposal, with no implicit production or publication authority.

The review patch uses zero context to preserve patch syntax without introducing whitespace-only context lines into the receipt. Its base and candidate blobs are pinned in the manifest; applying it requires `git apply --unidiff-zero` against that exact base.

## Tested source and measured outcome

Candidate: `90a61141a6a8ed6205aae144bbb99f8c9f0f9ec5`, isolated branch `codex/durable-execution-contract`. Current-main fix `c0e5a5b4617d131257e2c448f2259b645ac351ee` is merged locally. The [candidate patch](receipts/checkpoint-106-candidate-code.diff) and [blob manifest](receipts/checkpoint-106-candidate-manifest.json) identify 384 changed non-documentation paths, including tests and migration compatibility archives. Nothing was pushed or deployed.

The clean source-bound full pipeline passed on September 8, 21:07:56–21:10:16 UTC: 5,406 daemon tests plus 942 other package tests passed; one existing Linux-only case was skipped on macOS. Install, lint, configured build/type checks, audit and secret scan passed. The unchanged Linux implementation/callback has a retained prior extracted-function execution receipt, verified by hash comparison. See [checkpoint 106](checkpoint-106.md) for exact receipts and limitations. Prior failures, including checkpoint 105's report-formatting failure, remain dated failure receipts.

Final matched local replay: baseline 624.135832 ms, candidate 1,822.825459 ms; reduction **-192.055890%**, zero escaped seeded defects in either mode. The 25% speed target is unsupported on this fixture. Coverage and authority were unchanged. This tiny deterministic fixture cannot establish a live-workload gain; the measured cost of the complete reuse path exceeds the work saved here. No paid comparison is implied or required to manufacture a better result.

## Six-workstream disposition

| Workstream | Implemented local behavior and proof | Outstanding acceptance |
|---|---|---|
| 1. Completion, decisions, recovery, delivery | Durable completion cycles, unanswered-input admission, acknowledged guidance/attached reply delivery, source snapshots, source-bound delivery/merge intent and immutable confirmation, task execution and cleanup ownership. Actual manager/MCP fault tests cover loss, duplicates, restart and competing owners. CP103/105 retain unresolved ownership without guessing termination. | Current deployed/source/resource identity; visible native decisions/recovery/disposition. Particular abandoned claims remain retained until trustworthy identity and observed exit are established. |
| 2. Task retries, accounting, evidence reuse | Task/run/attempt identity across linked work; conservative unchanged-failure rules, explicit bound override, bounded transient backoff and deadlines; retained budgets/costs and explicit missing/non-additive duration evidence; complete-input cache identity and frozen review ledgers. CP94–104 and final suites/replay. | Visible native retry/binding/time/cost interaction and deployed provenance. Missing infrastructure/billing evidence stays unavailable; no invented total. Benchmark measurement is locally satisfied with a negative target result. |
| 3. Dispatch and environment | Strict fresh fetch, actual-base create/update/delete checks, equivalent-work detection, distinct intentional reruns, required command/resource/provider admission, effective-user atomic runtime config installation and supported NuGet search semantics. Final suites cover rejection before worker execution and continuation ownership checks. | Actual intended sandbox image capability canary and current deployed binding/image/CLI identity; native rerun/reconciliation interaction. |
| 4. Metrics, history, views | Separate task/pod/provider/validation/delivery units and denominators, explicit skipped/waived/unavailable/disposition states, retained histories through deletion, bounded malformed-row projections and snapshot exports, provider/phase/task/fleet subtotal reconciliation. CLI, shared/API, mobile and native implementations updated. | Proven cause or disproof of the historical hosted broad API failure; visible native interaction. Public health and a malformed fixture are insufficient production diagnosis. |
| 5. Scheduled collection and triage | Actual scheduler executes versioned deterministic exact-window collection before bounded judgment. Empty delta remains empty; incomplete execution remains incomplete; stable unresolved findings and reports survive workers; repairs require saved human selection. Actual scheduler/API/CLI/mobile regressions retained. | Visible native scan/report/triage interaction. A new paid judgment cohort or live schedule conversion is not added as a mandatory acceptance requirement. |
| 6. Release and backup provenance | Per-execution provenance, health/readiness/operator fields, WAL-aware intended-DB backup/receipts, freshness/headroom checks and isolated restore verification; compatible migration archives and copy-only reconciliation. Existing deployment safeguards retained. | Current guest release/bundle/CLI/image/capability identity; actual intended DB/backup scope/freshness and a sampled isolated restore. Neither dated local backups nor missing one directory prove all hosted backups absent. |

## Final audit boundaries

Completion/side-effect ownership is implemented in `completion-journal`, `operator-guidance-delivery`, `delivery-ledger`, `merge-journal`, `deletion-ownership` and actual manager/reconciler call sites. Passing fault tests distinguish a saved decision, an admitted external request, an observed confirmation and retained ambiguous ownership. A failed lookup/response is not permission for duplicate delivery. Cleanup deadlines do not settle unfinished work; late fulfilled steps can be retained without repeating known successful cleanup. These are protocol and local orchestration proofs, not claims of universal remote exactly-once execution.

Worker admission creates task/run/retry/provider identity atomically before consuming the actual runtime stream. Continuation preflight checks the saved lifecycle/provider binding again after asynchronous probes; stale generations and unresolved decisions retain current work. Required command/resource and actual-base gates remain substantive. Tests cover the demonstrated races and refusals; a pending current cloud ownership claim still needs external identity and observed termination evidence.

Accounting preserves units and missingness: provider corrections replace duplicate legacy totals; phase attribution conflicts remain visible; stored agent plus harness subtotals are not relabelled billing truth. Duration evidence reports valid/invalid/missing records and overlapping stage scope instead of adding overlapping intervals into invented wall time. Historical cohorts and export records survive pod deletion; live backlog remains a live-resource count. Final-source tests cover representative malformed sizes, WAL read snapshots, unsafe duration aggregates, retained task budgets and one logical delivery across duplicate source-bound observations.

The configured full pipeline does not execute visible native interaction. CLI actual HTTP actions and selected built-mobile DOM/screenshots are recorded in the ledger, including the newest duration coverage and restart ownership note. Swift source/build/decoding/request/mapping tests prove those layers only. Main's final merge changes managed Git transport and Vitest exclusions, not the client sources covered at checkpoint 105; the unchanged-client comparison is recorded in the audit receipt. No phone hardware requirement is added.

Representative migrations through 182 are tested locally. The current-branch inventory found 173 remote heads, maximum 152, with all inspected objects present. Deployed migration compatibility remains unknown. A release candidate that introduces durable claim/acknowledgement tables cannot be rolled back safely by changing a binary symlink alone while claims or new decisions remain; the packet preserves pre/post-cutover evidence and requires compatible data reconciliation.

The criterion-reference audit confirms existing implementation/test/evidence paths; it is an index consistency check, not a substitute for behavioral evidence. Each ledger entry keeps its own original reproduction and verification receipts. The generated criterion disposition below records the remaining requirement without silently dropping work.

## External evidence and authority

Current read-only Azure control-plane evidence identifies VM `autopod-daemon`, resource group `ewi-sandboxes`, subscription `06bb959b-9458-41a6-bdf5-77cc12feaab9`, immutable VM ID `3addc9bc-4812-4892-98d6-c40d5ab893c0`, location `swedencentral`. Public health returned 200/ok at 21:16:35 UTC; queried release/image/readiness fields were absent. These observations do not establish guest release, database or sandbox identities.

Automatic approval review rejected the earlier guest metadata export because payload-specific production egress approval was missing. A revised bounded payload is now reviewable and locally tested; it has not been retried through SSH or another bypass. It exports no raw row/log/stack/SQL identifier/environment/credential/backup content. One approved Run Command inspection is the smallest next step; estimated additional provider/sandbox spend is $0.

After that evidence, select the real backup and exact canary image/tier/configuration, obtain the needed bounded authority, and execute the isolated restore and actual-image capability test. No rollback SHA, image digest or price is guessed. Publication/deployment/restarts/live mutations and paid canaries remain separately gated. Visible native acceptance needs supported interaction access or a user-performed local walkthrough. The goal must remain incomplete until these required results are recorded.

## Criterion disposition

Local verification is scoped to the exact tested candidate; partial/unverified entries retain their explicit prerequisites in the acceptance ledger.

| Criterion | Requirement | Disposition |
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
| W3.4 | Supported capability probe resolves sandbox config ownership and registry execution semantics | partial |
| W3.5 | Queued provider binding survives mutable profile changes with actionable reconciliation errors | partial |
| W3.6 | Live actual-image capability canary verified under explicit authority | unverified |
| W4.1 | Logical tasks, pods, provider attempts, validation executions and delivery receipts have distinct units | partial |
| W4.2 | Executed pass/fail, skipped, unavailable, waived, no-change, cancelled, external and unresolved outcomes remain explicit | partial |
| W4.3 | First-pass and delivery denominators require evidence; one logical delivery counts once | partial |
| W4.4 | Latest validation, history, waivers and delivery reconcile without rewriting failures | partial |
| W4.5 | Live broad history/cost API root cause proven before claiming production repair | unverified |
| W4.6 | Bounded projections and per-record diagnostics preserve healthy rows with malformed legacy records and realistic payload sizes | partial |
| W4.7 | Task/phase/attempt cost totals reconcile with explicit telemetry completeness | partial |
| W4.8 | Affected APIs, shared contracts, CLI, desktop and mobile updated and interactions verified | partial |
| W5.1 | Versioned deterministic stack/delta/scanner collection precedes bounded agent judgment in actual scheduling path | partial |
| W5.2 | Exact delta preserved and empty delta never widened | partial |
| W5.3 | Incomplete scanner execution cannot report clean | partial |
| W5.4 | Stable finding identities preserve unresolved findings across runs without duplicate prompts | partial |
| W5.5 | Reports and triage survive worker lifetime and disconnected human wait | partial |
| W5.6 | Repairs launch only after required human selection; report-only completion differs from patch delivery | partial |
| W6.1 | Execution records contain daemon SHA, CLI version, image digest, contract/validation identity and capabilities | partial |
| W6.2 | Health and operator release/readiness views identify meaningful release and failure provenance | partial |
| W6.3 | Active hosted database and backup scope verified without inferring all hosted backups missing | unverified |
| W6.4 | Freshness and disk headroom checks added while preserving cleanup/deployment safeguards | partial |
| W6.5 | Sampled backup restores in isolation with freshness and integrity verification | partial |
| G.1 | Historical strict fetch, validation-only recovery, bounded review, ledgers, history sequences, Codex transport/OAuth, ADO auth and guarded deployment retain regression coverage and deployment status evidence | partial |
| G.2 | Migration numbering checked against current branches and representative prior database upgrades verified | partial |
| G.3 | All affected suites and full repository validation pipeline pass on exact recorded commits | verified |
| G.4 | Desktop/mobile/CLI supported-surface interactions verified; compilation alone is insufficient | partial |
| G.5 | Deployment/rollback identities, canary scope and spend prepared before requesting gated actions | partial |
| G.6 | Final closure maps every recommendation to implementation/tests/evidence/prerequisites; no unverified acceptance treated as PASS | partial |

[Machine-readable audit](receipts/checkpoint-106-criterion-audit.json) records reference counts, remaining prerequisites, unique active migration prefixes and unchanged final client/application source.
