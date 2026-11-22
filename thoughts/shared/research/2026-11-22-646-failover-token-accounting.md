---
date: 2026-11-22T17:54:24+00:00
researcher: Claude (Autopod pod running-spoonbill)
git_commit: dceb1f9e636647986b418fa1f9b7b0bb3d305d29
branch: fix/646-failover-token-accounting
repository: autopod
topic: "#646 — why a provider failover after a pre-usage fatal provider refusal is blocked by 'Task token accounting incomplete'"
tags: [research, codebase, daemon, task-execution-ledger, provider-failover, token-telemetry]
status: complete
last_updated: 2026-11-22
last_updated_by: Claude
---

# Research: provider failover blocked by "Task token accounting incomplete" (#646)

## Research Question

When the primary provider attempt fails fatally before producing usage (e.g. Codex "Your
workspace is out of credits"), Autopod queues the configured failover, re-prepares the pod
(~12 min) and then fails at agent spawn with `Task token accounting incomplete; reconcile prior
execution and phase telemetry before starting more budgeted work.` Where is that decided, what
state produces it, and what paths exist today for settling or reconciling it?

## Summary

- The block is `snapshot().budgetCheck = { status: 'unavailable' }` in the task execution ledger,
  enforced by `beginRun()` when the next worker run starts
  (`packages/daemon/src/pods/task-execution-ledger.ts:483-505`, `:744-745`). `beginRun` runs inside
  `consumeAgentEvents` initialisation (`packages/daemon/src/pods/agent-event-consumption.ts:192-214`),
  i.e. **after** the full provisioning/preparation of the continuation run.
- `incompleteSpending` becomes true for a pod row when the row has prior work (`priorRuns > 0`,
  i.e. any `task_agent_runs` row) and either
  - `token_telemetry_accuracy` is not `complete`/`repaired` (`task-execution-ledger.ts:303-310`), or
  - `phase_token_usage` is NULL (`task-execution-ledger.ts:320-324`).
  This only matters when a positive task token budget exists: `unlimited` is decided before
  `incompleteSpending` (`:483-490`). The repro had a 1,000,000 budget.
- A pod's `token_telemetry_accuracy` defaults to `'partial'` (migration
  `134_token_telemetry_corrections.sql:3-4`). It becomes `complete` only when a `complete` event with
  totals arrives (`agent-event-consumption.ts:536-548`). A run that ends with a fatal provider error
  before any usage never changes it, and `phase_token_usage` stays NULL. Therefore after one failed
  pre-usage run the pod has `priorRuns = 1`, `partial`, no phase usage → the ledger blocks the next
  run in the same task.
- The account-refusal failover path (`auth` + definitive + out-of-credits/revoked wording) pauses the
  pod `provider_limit`, closes the provider attempt as `failed` with the handoff reference and calls
  `handleProviderLimit` → `queueProviderContinuation` (`agent-event-consumption.ts:735-760`,
  `:850-870`; `provider-continuation.ts:108-170`, `:172-250`). None of these settle the token
  telemetry. `queueProviderContinuation` opens the target attempt and requeues without consulting
  the ledger.
- The continuation run then fails in `beginRun`; `processPod`'s catch sees the active target attempt
  follows a provider-failover handoff and parks the pod `paused/provider_limit` with
  `Provider target failed to start — source work and continuation history preserved`
  (`agent-process-workflow.ts:860-917`). Result: 1 agent run, 2 provider attempts.
- An existing narrow settlement exists only for **failed local** pods: `releaseZeroWorkFailure`
  (`zero-work-failure-release.ts:41-105`) uses `assessZeroWorkProviderAccountFailure`
  (`zero-work-failure.ts:22-77`) and writes `tokenTelemetryAccuracy: 'complete'` plus a zero
  `agent_initial` phase bucket. It runs only from `processPod` after `outcome === 'failed'`
  (`agent-process-workflow.ts:740-743`), so it never runs on the failover (`paused`) path.
- Reconciliation paths today: admin/operator-only `POST /admin/token-telemetry/repair`
  (`api/routes/token-telemetry.ts:52-78`, CLI `ap daemon repair-token-telemetry`), and the
  owner-or-operator `claude-telemetry` repair which only applies to a frozen failed local Claude pod
  with a native session file (`claude-session-telemetry.ts:183-310`). Neither applies to a paused
  failover pod whose failed attempt never produced usage. Reviewer runs have an analogous
  "accepted with unknown usage" reconciliation (`validation/reviewer-run-repository.ts:283-333`,
  surfaced in ledger diagnostics at `task-execution-ledger.ts:234-237`).
- The block reason names nothing: the generic string is produced once in the ledger and rendered
  verbatim by CLI (`cli/src/commands/pod.ts:841`), mobile-web
  (`mobile-web/src/components/TaskExecutionPanel.tsx:113`), the reviewer gate
  (`validation/reviewer-run-repository.ts:120-142`) and the desktop decoder. Diagnostics name the pod
  id only (`${row.id}: agent telemetry incomplete`).

## Detailed Findings

### Task execution ledger admission

- `snapshot(podId)` (`task-execution-ledger.ts:177-560`) iterates every retained pod in the logical
  task. Per row: provider attempts ledger (`readProviderUsage`) is authoritative over pod totals
  (`:241-252`); `priorWork` (`:263-273`) is true when any `task_agent_runs` row exists, any settled
  provider attempt exists, or any usage/cost is positive.
- Accuracy check (`:303-310`) and phase-null check (`:320-324`) both set `incompleteSpending` only
  when `priorWork`.
- `budgetCheck` (`:483-505`): unavailable source → `unavailable`; budget null/≤0 → `unlimited`;
  usage ≥ budget → `exhausted`; `incompleteSpending` → `unavailable` with the generic reason; else
  `below_recorded_limit`.
- `beginRun` (`:690-756`) throws `TASK_BUDGET_EXHAUSTED` or `TASK_BUDGET_UNAVAILABLE` (409).
- Test coverage: `task-execution-ledger.test.ts:329` asserts the reason contains
  `Task token accounting incomplete`.

### Pod telemetry accuracy lifecycle

- `usage` checkpoint events always set `partial`; `complete` events with totals, no
  `usageIncomplete` and no unsettled runtime segments set `complete` (or `repaired` when the pod was
  repaired, or `partial` when prior usage was incomplete) (`agent-event-consumption.ts:536-548`,
  `priorUsageIncomplete` at `:156-162`).
- `error` events with `usageIncomplete` force `partial` (`:360-361`). Codex marks usage conflicts
  this way (`runtimes/codex-stream-parser.ts:116-125`, `runtimes/codex-runtime.ts:557-566`).
- Phase buckets are written per agent attempt key (`agentPhaseBucketKey`,
  `pods/agent-execution-policy.ts:17`).

### Fatal provider error handling and failover

- Fatal error handling (`agent-event-consumption.ts:708-771`): classification; `auth` failures get
  failure reason prefix `Provider account unavailable`; `quota_exhausted` definitive → pause
  `provider_limit`; account refusal with an available failover target
  (`providerAccountUnavailableState`, `runtimes/provider-error-classifier.ts:64-74`, out-of-credits
  wording at `:57-60`) → pause `provider_limit`, `accountFailover = true`; otherwise fail.
- Finally block (`:826-895`): quota path closes attempt `quota_exhausted` then `handleProviderLimit`;
  account-failover path closes attempt `failed` with handoff reference, calls `handleProviderLimit`,
  and if the pod is still `paused/provider_limit` afterwards transitions it to `failed`
  ("an account refusal has no reset to wait for").
- `handleProviderLimit` (`provider-continuation.ts:172-251`) aborts the runtime, syncs the workspace,
  kills the container, selects a failover target and calls `queueProviderContinuation(..., true)`;
  errors are logged and emit `Provider limit reached — automatic continuation is unsafe`.
- `queueProviderContinuation` (`:108-170`) prepares the handoff file, opens the target provider
  attempt, updates runtime/model/account, transitions to `queued` and requeues.
- Manual `continueProvider` (`:253-505`), route `POST /pods/:podId/continue-provider`
  (`api/routes/pods.ts:1539-1570`), CLI `ap continue-provider` (`cli/src/commands/pod.ts:1098-1117`).
  It requires a paused provider-limit pod with definitive `quota_exhausted` evidence or explicit
  profile-primary recovery of a failed pod.
- Existing tests: `pods/provider-account-failover.test.ts` (real SQLite pod manager, refusal stream,
  asserts queued continuation and attempts) — does not set a token budget, so the ledger block is
  never exercised there.

### Zero-work evidence and settlement

- `assessZeroWorkProviderAccountFailure` (`zero-work-failure.ts:22-77`): requires provider-account
  failure reason, auto agent mode, zero pod usage, zero provider attempt usage, no source/validation/
  delivery/escalation/recovery evidence, and no `pod.agent_activity` events other than `status`/
  `error` (event repository).
- `releaseZeroWorkFailure` (`zero-work-failure-release.ts:41-105`) applies only to failed local pods
  and also releases resources; tested in `zero-work-failure-release.test.ts:58-81`.

### Owner-scoped audited precedents

- `claude-session-telemetry.ts:183-195` authorises pod owner (`pod.userId === oid`) or
  admin/operator and records an `authorizationBasis` in an immutable receipt
  (`claude_session_telemetry_receipts`).
- Reviewer reconciliation records `usage_basis = 'unknown-accepted'`, actor and note
  (`reviewer-run-repository.ts:283-333`; migration `211_reviewer_run_reconciliation.sql`).
- Append-only correction table pattern with triggers: `134_token_telemetry_corrections.sql`.
- Latest migration prefix on this commit: `275_retained_cleanup.sql`.

## Code References

- `packages/daemon/src/pods/task-execution-ledger.ts:303-324` — accuracy/phase incompleteness.
- `packages/daemon/src/pods/task-execution-ledger.ts:483-505` — `budgetCheck` and generic reason.
- `packages/daemon/src/pods/task-execution-ledger.ts:744-745` — `beginRun` admission throw.
- `packages/daemon/src/pods/agent-event-consumption.ts:192-214` — `beginRun` at run start.
- `packages/daemon/src/pods/agent-event-consumption.ts:708-771` — fatal error classification/pause.
- `packages/daemon/src/pods/agent-event-consumption.ts:826-895` — attempt close + `handleProviderLimit`.
- `packages/daemon/src/pods/provider-continuation.ts:108-251` — queue/handle continuation.
- `packages/daemon/src/pods/agent-process-workflow.ts:860-917` — spawn failure parking message.
- `packages/daemon/src/pods/zero-work-failure.ts:22-77` — zero-work evidence.
- `packages/daemon/src/pods/zero-work-failure-release.ts:61-70` — zero settlement write.
- `packages/daemon/src/api/routes/token-telemetry.ts:52-78` — admin-only repair.
- `packages/daemon/src/pods/claude-session-telemetry.ts:183-195` — owner-or-operator authorisation.

## Architecture Documentation

- Budget integrity is enforced centrally by the ledger and re-checked at each budgeted start
  (worker `beginRun`, reviewer `reserve`, recovery forks, repair continuation).
- Pod-level `token_telemetry_accuracy` is pod-wide across provider attempts; there is no per-attempt
  accuracy column.
- Audited corrections use append-only tables + immutable receipts and keep original evidence.

## Open Questions

None for current-state research.
