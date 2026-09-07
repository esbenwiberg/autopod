# Autopod: improvements supported by recent execution evidence

Analysis date: 7 September 2026. Recommendation: make validation, recovery, and delivery into a durable, measurable lifecycle before expanding agent capability. The strongest opportunity is reducing repeated work and operator repair while retaining the existing evidence gates.

## Evidence and limits

I read all 164 hosted pods created since 1 August, following compact API pagination to exhaustion, and fetched their individual metadata and validation histories. The first creation in that cohort was 2 August; the latest was 3 September. Five were interactive workspaces; the main analysis uses the remaining 159 automatic pods. Repository comparison covers the same period: 215 non-merge commits, ending at `2d5456edac542a99d27f12eb1dbd16e5ad8c2c2a` on 26 August. Local HEAD and live remote main match. This is a creation cohort, not a sample of whichever failures were easiest to find.

The hosted service reports healthy, schema 139, zero active queue sessions, and four running containers. Its exact running release SHA was not obtained: a read-only Azure Run Command did not return before I stopped waiting. Therefore, “fixed in current source” below is stronger than a commit-message inference but does not mean every historical run used that fix. The service's version `0.0.1` does not resolve this ambiguity.

A September 6 local backup contains 555 pods ending in June. I excluded it from recent-run statistics. Backup filename freshness is not data freshness. The live API reports 891 pods overall. Broad list reads and cost analytics return HTTP 500; pages of ten and all 164 individual pod/validation reads succeeded. Their production root cause remains unproven.

Primary data, reduced to relevant noncredential fields, is in [evidence.json](/Users/ewi/repos/autopod/docs/analysis/2026-09-07/evidence.json). [commits.txt](/Users/ewi/repos/autopod/docs/analysis/2026-09-07/commits.txt) records the source timeline. Historical deployment/disk incidents were also located through prior session records; those are historical observations, not current disk measurements.

## What the cohort actually says

| Observation | Result | Interpretation |
|---|---:|---|
| Automatic pods | 159 | 130 complete, 24 killed, 4 failed, 1 awaiting input |
| Automatic pods with validation history | 121 | 346 saved validation records; 66 pods have multiple records |
| Saved validation outcomes | 255 fail, 91 pass | Includes infrastructure and interrupted/fail-closed evidence; not 255 agent coding failures |
| Review executed at least once | 74 pods | 52 had at least one failed review; 32 records across 20 pods explicitly describe degraded councils |
| Tests executed at least once | 118 pods | 20 had at least one test failure |
| Build executed at least once | 121 pods | 2 had at least one build failure |
| Facts executed at least once | 49 pods | 11 had at least one fact failure |
| SAST executed at least once | 6 pods | 115 pods have at least one skipped SAST record; absence of findings is not broad coverage |
| Recorded validation duration | 26.85 hours | Sum of run durations, not wall-clock critical path; ten pods account for 34.7% of records |
| Recorded agent cost | $1,975.29 | $758.48 initial work and $1,216.81 rework: 61.6% of recorded agent cost is rework |
| Additional recorded review cost | $302.59 | Agent plus review totals $2,277.87; excludes unrecorded usage and infrastructure |

The cost fields are estimated telemetry, not invoices. Twenty-four of the 164 records have partial token telemetry. These figures show where measured effort went; they do not establish recoverable savings. Rework can fix valuable, real defects.

Complete does not uniformly mean “validated PR delivered.” Nineteen complete automatic pods have no saved validation rows; no-change and validation-off paths exist. Twenty-seven complete pods with history have no passing history row. Selected examples have explicit human waivers or a newer passing pod-level result. `anxious-takin` and `tender-mink` have human acceptance; `outside-swift` has a passing latest result despite its stored history rows being failed. `unique-magpie` was killed after external PR completion in its historical record. These are reasons to expose evidence and disposition separately, not allegations that every completion was wrong.

The cohort is heterogeneous. Autopod-self has 25/25 complete automatic pods and Pilot 60/62, while TeamPlanner PR-read has 4/14 complete, five killed, four failed, and one awaiting input. Models, tasks, profiles, dates, and operator choices are confounded. The raw model leaderboard cannot establish a better default model.

## Ranked improvements

### 1. Make completion, escalation, and recovery one durable lifecycle

**Value: highest reliability and operator benefit. Confidence: high in the defect; medium in the architectural payoff.**

`rolling-earthworm` on 31 August completed its agent run after unsuccessful human-triage calls. The pod remained `awaiting_input`; finalization then tried to transition it to `complete` and failed. Its event history explicitly reports rejected blocker/summary calls while parked. `acceptable-cephalopod` remains awaiting input with a completed provider attempt and a worktree-compromised flag. The interactive `dual-minnow` is a separate workspace, not evidence of a stuck coding worker.

Current source reproduces the incompatible pieces: a complete runtime event selects `handleCompletion`, while the no-change path attempts completion without reconciling unresolved input. The transition guard correctly refuses `awaiting_input → complete`. Removing that guard would conceal the problem and could bypass a human decision.

Introduce a durable finalization decision that distinguishes agent settlement, outstanding decisions, source preservation, validation, delivery, and external disposition. Store the decision and its execution generation transactionally; make side effects resumable and idempotent. Preserve summaries even when a decision is outstanding. Reconcile disconnected/expired MCP waits explicitly, retaining human authority. Show the operator the pending decision, preserved work, exact recovery step, and whether any new agent work is required.

Start by extracting completion/escalation handling from the 16,427-line pod manager, then provider recovery and delivery. Keep the current daemon and SQLite initially. Existing lifecycle-generation checks, checkpoints, provider attempts, and validation sequences are useful foundations; a wholesale distributed rewrite is not justified by this evidence.

**Validation:** the observed state pair is rejected in the characterization suite, and the event sequence and unguarded finalization path were traced. This is not yet an end-to-end reproduction of all MCP timing. Acceptance for implementation: replay escalation→disconnect→agent-complete, late human reply, duplicate completion, and daemon restart at each boundary. No illegal transition, lost summary, duplicate push, or implicit approval; an unanswered decision remains actionable.

Source: [runtime completion dispatch](/Users/ewi/repos/autopod/packages/daemon/src/pods/pod-manager.ts:9736), [no-change completion](/Users/ewi/repos/autopod/packages/daemon/src/pods/pod-manager.ts:10681), [state guard](/Users/ewi/repos/autopod/packages/shared/src/constants.ts:114).

### 2. Govern retries across the entire task, with evidence reuse tied to exact inputs

**Value: largest measured efficiency opportunity. Confidence: high that repetition matters; savings unproven.**

`experienced-leopon` needed 16 validation records before a saved pass. `silly-gazelle` has 17, including repeated test/tool failures and later substantive review findings mixed with council unavailability. `grotesque-porpoise` has nine records; seven explicitly classify `SANDBOX_MEMORY_EXHAUSTED` as nonretryable and say repository rework is not indicated. A human ultimately waived the failed result. Some repeated executions were operator-directed: this is not evidence of an uncontrolled automatic retry loop.

Current per-call retry limits and validation-only Resume already help. What is missing is a durable explanation of why another execution should differ. Add a retry decision keyed by source tree, contract, environment/image, command, failure category, and validation/review version. A nonretryable failure should require evidence that the relevant condition changed, or an explicit recorded override. Transient provider failures should use bounded delayed retry in the same authorized binding; they should not consume coding-rework attempts.

Expose cumulative initial-agent, repair-agent, review, validation-time, and infrastructure expenditure across resumes and linked fix pods. Give operators a concrete “same blocker, unchanged inputs” warning and incremental cost estimate before another recovery cycle. Budget policies already exist; unify their task-level accounting rather than add another unrelated counter.

Reuse successful deterministic phases only when all relevant inputs match, including toolchain, environment, command, dependency lockfiles, and the tested tree. Preserve the frozen finding ledger and canonical review provenance. Re-review only the affected evidence where supported; retain full gates for changed or unknown inputs.

**Validation:** 18 records have explicit infrastructure failures, including six additional occurrences of the same nonretryable memory code in one pod. Environment identity is missing, so these are candidates for prevention, not six proven avoidable retries. Forty-four focused existing lifecycle/validation tests passed, including bounded infrastructure retries and validation-only recovery. Acceptance: replay repeated failures across restart and Resume; changed inputs permit reevaluation, unchanged nonretryable inputs cannot silently launch another agent, and all cumulative budgets survive resets. In a matched pilot, target at least 25% lower repeated validation time without additional escaped seeded defects. That target is proposed, not measured.

This design follows bounded retry and idempotency guidance from [Microsoft](https://learn.microsoft.com/en-us/azure/architecture/best-practices/transient-faults) and [AWS](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/?did=ba_card&trk=ba_card).

Source: [Resume eligibility](/Users/ewi/repos/autopod/packages/daemon/src/pods/pod-manager.ts:15604), [review-only retry regression](/Users/ewi/repos/autopod/packages/daemon/src/validation/local-validation-engine.test.ts:3072).

### 3. Reject stale work and incompatible environments before paid execution

**Value: high prevention benefit, relatively bounded implementation. Confidence: high for the demonstrated cases.**

`nasty-earwig` started at `62b090dc` with four facts requiring files to be created. All four already existed at that exact start commit. Their commands passed, but the create requirements failed. The pod made three commits and changed 12 files before cancellation. I verified the four paths directly with `git ls-tree` at its recorded start SHA. This is a stale dispatch contract, not evidence that Codex checked out the wrong branch.

Add a preflight report after fresh remote refs are established and before starting the agent: declared create/update/delete operations against the actual base; recent/active equivalent task identity; required commands and resource needs; compatible provider binding; and supported filesystem ownership operations. Existing artifacts should trigger stale-contract review, never automatic acceptance that the entire task is satisfied. Intentional reruns must remain possible with a new execution identity.

Two runs, `abstract-quokka` on 23 August and `electoral-weasel` on 30 August, failed securing Codex config because `chown` was not permitted. Current source still invokes `chown … && chmod …` with a root request; permission-mode changes alone do not prove that execution capability works. Verify the effective sandbox user and ownership operation in a reusable capability probe. `sharp-swordtail` also recorded an invalid `dotnet nuget search` registry probe; that is a tool-command compatibility warning, not proof of expired registry credentials.

`victorious-rabbit` failed before starting because its selected provider binding could not be reconciled with attempt history. Keep that fail-closed guard. Resolve the authorized binding before queueing and persist it independently of subsequent mutable profile changes. Do not silently choose a different account or model.

**Validation:** exact-base artifact existence and real failures are verified; current provider-binding and ownership paths were inspected. Acceptance: stale-create, missing-update, duplicate submission, missing command, denied ownership, insufficient memory, and profile-edited-after-queue cases all produce useful preflight results without spawning a coding agent. One live capability canary on the actual sandbox image is still required before claiming the environment problem fixed.

Source: [Codex ownership setup](/Users/ewi/repos/autopod/packages/daemon/src/runtimes/codex-runtime.ts:1152), [binding reconciliation](/Users/ewi/repos/autopod/packages/daemon/src/pods/pod-manager.ts:2499).

### 4. Make telemetry describe delivered outcomes and real coverage

**Value: prerequisite for sound optimization; small fixes should ship early. Confidence: high.**

The reliability aggregator counts a present stage object as “ran,” including `status: skip`. It calls any complete/no-rework pod a first-pass success, regardless of validation evidence. The model aggregator counts provider attempts under fields named podCount/completeCount and computes dollars per PR using those completed attempts. In the live 45-day view, there are 289 logical terminal pods but 736 model-attribution rows. These are different units, not directly comparable success rates.

A local fixture with one killed pod and two completed agent attempts reports two model successes and $1 per PR, despite no delivered PR in the fixture. This attribution can be useful for runtime accounting, but the labels and delivery denominator are wrong for selecting models.

Separate logical task, pod, provider attempt, validation execution, and delivery receipt. Report accepted-with-waiver, externally completed, no change, cancelled, unresolved, and verified delivered outcomes. Count pass/fail executions separately from skip/not-applicable/unavailable. Preserve raw measurements and show missing coverage. Join agent, review, linked fix, and infrastructure costs at the task level; do not double-count attempts. Compare models only within matched task families and environments.

Also repair broad history/cost API availability. The cost aggregator reads and materializes every pod before filtering. A local malformed historical JSON fixture can break an unbounded list while an individual healthy record remains readable. This demonstrates a possible fragility, not the proven cause of the production HTTP 500s. Use bounded database projection and explicit per-record corruption diagnostics; investigate server logs before patching the observed failure.

**Validation:** four telemetry/history characterization cases reproduce current behavior. Acceptance: skip-only fixtures have zero executed coverage; unresolved and waived results stay visible; one logical delivery counts once regardless of attempts; cost totals reconcile with phase/attempt ledgers; one malformed legacy row cannot hide healthy recent rows. API tests should include representative production-sized records, not just row counts.

Source: [stage counting](/Users/ewi/repos/autopod/packages/daemon/src/pods/reliability-aggregator.ts:411), [attempt attribution](/Users/ewi/repos/autopod/packages/daemon/src/pods/models-aggregator.ts:365), [unbounded cost read](/Users/ewi/repos/autopod/packages/daemon/src/pods/cost-aggregation.ts:109).

### 5. Turn scheduled scans into deterministic collection plus bounded judgment

**Value: strong operator benefit in the weakest recurring cohort. Confidence: medium; validate by task family.**

Fourteen automatic pods were scheduled jobs. Recent TeamPlanner scans illustrate a mismatch between unattended schedules and interactive triage: a scan can spend time waiting on a human, lose its MCP response stream, then fail finalization. The August 31 and September 3 agent messages also describe widening the delta window when no recent commits were present. That is observable divergence from the task's strict scope, not a reason to trust the expanded scan as better coverage.

Run stack detection, exact delta enumeration, supported dependency/secret scanners, and result normalization as versioned deterministic steps. Give the agent a bounded evidence packet for explanation and prioritization. Persist triage as an operator inbox item that can outlive the worker; launch repairs only after the existing human selection. Record report-only completion separately from patch delivery. Carry unresolved findings forward with stable IDs so the operator sees changes rather than repeated full triage.

**Validation:** current job metadata and agent events support the workflow mismatch; scanner accuracy itself was not independently audited here. Acceptance: empty-delta runs do not widen scope; incomplete scanner execution cannot report zero findings; repeated scans preserve unresolved findings without duplicate prompts; disconnected human triage does not fail report collection. Evaluate report-only and repair tasks separately.

### 6. Add release and recovery provenance, including backup freshness

**Value: makes every future incident cheaper to diagnose. Confidence: high in the observability gap.**

Record daemon SHA, runtime CLI version, image digest, effective capability results, contract hash, and validation implementation version per execution. Extend health with that identity and a meaningful readiness view. Current source already has profile snapshots and source/checkpoint identities; fill the environment and release gaps.

The historical August 20–24 disk/deployment incidents were recovered, and guarded deployment/cleanup scripts now exist. Do not treat that old outage as a current incident or propose another deployment-script rewrite. Add disk/headroom admission evidence and verify that backups cover the active hosted database. A backup that succeeds against an obsolete database is operationally misleading.

**Validation:** current health lacks the release identity needed for this analysis, and the September backup's newest pod is in June. The backup's intended scope has not been established; this is an observed coverage gap, not proof that all hosted backups are absent. Acceptance: an operator can map every new failure to an exact release/image, detect stale backup contents, and restore a sampled backup into an isolated environment without changing production.

## Historical fixes: retain them, do not rediscover them

| Historical issue | Current evidence | Remaining work |
|---|---|---|
| Stale remote refs and lost host-fetch retry state | August 20 strict-fetch series, merged in `482cbd00`; present in current source | Add contract freshness after the fetch gate |
| Validation-only recovery restarting implementation; unbounded reviewer calls | August 13–14 fixes; focused current lifecycle tests pass | Enforce cumulative retry decisions across separate Resume cycles |
| Review finding identity/closure drift | Frozen ledgers, structured closure, separate synthesis/closure budgets; August 3–14 fixes | Measure reviewer availability and defect precision; do not remove substantive findings to increase pass rate |
| Reused validation attempt numbers confusing history | `24f86cff` adds stable history sequence/cycle and worker accounting | Reconcile latest result, waiver, history, and delivery in one operator view |
| Codex sandbox transport/OAuth refresh | `430884a9` and `a8d3a595`; source and focused tests retain the fixes; archived post-fix work ran | Separate config ownership capability failure still appears August 30 |
| ADO tenant authentication | `ad6b5366` and `0674b95f`; current authentication tests pass; archived deployment verification exists | New provider-binding reconciliation failure is a separate problem |
| Hosted disk/release recovery | Prior recovery succeeded; guarded cleanup/deploy tooling exists | Proactive headroom and backup/release provenance; current disk not measured |
| Turbo orchestration | `2d5456ed` is current main | Full hosted CI and complete daemon suite were not rerun in this analysis |

103 of the 215 non-merge commit subjects mention validation or review. That is consistent with the run evidence, but commit count is not a measure of engineering hours or proof of causation. Post-August-14 records still include degraded councils, while the small later sample and missing per-run daemon SHA prevent a defensible before/after treatment-effect estimate.

## What was validated, and what should happen next

- **94 existing tests passed** across six targeted analytics, review, authentication, and runtime-default suites.
- **44 selected lifecycle/validation tests passed**; 506 tests were intentionally excluded by the name filter.
- **Six characterization tests passed**, demonstrating current limitations rather than claiming fixes. The initial fixture used a nonexistent repository getter; it was corrected and rerun successfully.
- The stale contract was checked against the pod's exact base commit. The complete recent creation cohort was retrieved rather than inferred from dashboard percentages.
- No production fix, pod lifecycle change, deployment, new worker, or model benchmark was performed. The large-list/cost API root cause and actual running release SHA remain unresolved.

Tests and receipts: [diagnostics.test.ts](/Users/ewi/repos/autopod/docs/analysis/2026-09-07/diagnostics.test.ts), [diagnostics.txt](/Users/ewi/repos/autopod/docs/analysis/2026-09-07/diagnostics.txt), [regression-tests.txt](/Users/ewi/repos/autopod/docs/analysis/2026-09-07/regression-tests.txt), [lifecycle-tests.txt](/Users/ewi/repos/autopod/docs/analysis/2026-09-07/lifecycle-tests.txt).

Suggested execution order: fix telemetry units and history reads alongside the concrete escalation/finalization defect; add preflight against exact source/environment; then add task-level retry governance and evidence reuse. Follow with the scheduled-scan split and provenance. Use the new outcome metrics to evaluate a bounded matched workload before choosing a different default model or a larger architecture change. A lower review-failure rate alone is not success: delivery quality, unchanged authority boundaries, operator interventions, and total cost per accepted outcome must improve together.
