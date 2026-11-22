# #646 Provider failover blocked by "Task token accounting incomplete" — Implementation Plan

## Overview

A provider attempt that is refused fatally before producing any usage must settle its token
accounting so the configured failover in the same task can start. When accounting is genuinely
uncertain, the failover must be refused **before** re-preparation, the status must name the
attempt, and the task owner gets an audited, owner-scoped "accept as unmeasured and continue"
action instead of needing the admin-only repair.

Research: `thoughts/shared/research/2026-11-22-646-failover-token-accounting.md`.

## Current State Analysis

- Ledger blocks the next run when a pod with prior runs has `token_telemetry_accuracy` not in
  {complete, repaired} or NULL `phase_token_usage` and a positive budget exists
  (`task-execution-ledger.ts:303-324`, `:483-505`, enforced by `beginRun` `:744-745`).
- A pre-usage fatal refusal leaves the default `partial` accuracy and NULL phase usage; the
  failover path (`agent-event-consumption.ts:826-895` → `provider-continuation.ts:172-251`) never
  settles them and queues the continuation without consulting the ledger, so the block only fires
  in `beginRun` after full preparation (`agent-process-workflow.ts:860-917`).
- The only zero settlement (`zero-work-failure-release.ts`) is for failed local pods.
- The block reason is generic and names nothing.

## Desired End State

1. Refusal with zero usage and no agent activity → attempt is settled as measured zero (accuracy
   `complete`, zero agent phase bucket, an activity line recording why) → failover queued and its
   run is admitted by `beginRun`.
2. Refusal (or quota stop) where usage is genuinely uncertain (any usage, any agent activity, a
   `usageIncomplete` error, more than one run on the pod, unverified termination) → no target attempt
   opened, no requeue, pod stays `paused/provider_limit` with a failure reason naming the pod and
   attempt (`provider attempt #N runtime/model`) and the owner command.
3. `budgetCheck.reason` names the pod(s)/attempt(s) whose telemetry is incomplete; CLI/mobile/
   desktop/reviewer already render the reason verbatim.
4. Pod owner (only) can run `ap accept-unmeasured-usage <pod> --reason "..." [--attempt N]`
   (`POST /pods/:podId/accept-unmeasured-usage`) which records an immutable receipt, marks the
   pod's accounting as reconciled, and — if the pod is parked `paused/provider_limit` — queues the
   configured failover. Ledger diagnostics show the acceptance.

### Key Discoveries

- Pod-wide accuracy means a zero settlement is only truthful when the whole pod has zero usage and
  zero work; we require that rather than per-attempt reasoning.
- `budgetCheck` is `unlimited` without a budget, so tests must set `tokenBudget`.
- `assessZeroWorkProviderAccountFailure` already encodes "no agent activity besides status/error".

## What We're NOT Doing

- No change to how genuinely partial usage (usage checkpoints without a final total) is counted;
  it still blocks (now earlier, with a name, and with the owner path).
- No new pod accuracy enum value (would require rebuilding `pods`); owner acceptance stores
  `repaired` with an immutable receipt holding the original values and reason.
- No admin/operator bypass in the new route (admins keep the existing repair tools).
- No pre-provisioning gate for every resume/rework path — only provider continuation (automatic
  and manual `continue-provider`). Spawn-time `beginRun` remains the backstop elsewhere.
- No desktop Swift changes (it renders the daemon reason string); no mobile UI action button.
- No change to the failed-local `releaseZeroWorkFailure` behaviour.

## Implementation Approach

Daemon-first: settle provable zero at the moment the attempt closes; gate continuation on the
ledger before opening the target; give the owner an audited reconciliation; then CLI.

## Phase 1: Settle pre-usage refusals and gate continuation early

### Changes Required

#### 1. Pre-usage refusal assessment
**File:** `packages/daemon/src/pods/zero-work-failure.ts`
- Extract the activity check into a shared helper and add
  `assessPreUsageProviderRefusal(pod, classification, evidence)` returning qualifies/reason.
  Qualifies only when: classification definitive and (`auth` with
  `providerAccountUnavailableState(...) !== null` or `quota_exhausted`); pod input/output/cost all 0;
  every provider attempt for the pod has zero tokens/cost; no non-status/error agent activity on the
  pod; pod accuracy is `partial`; exactly one `task_agent_runs` row for the pod (supplied as
  evidence count); event repo and provider attempt repo available.

#### 2. Settlement on the failover path
**File:** `packages/daemon/src/pods/agent-event-consumption.ts`
- Track `usageObservedThisRun` (any `usage` event or `complete` with totals) and
  `usageIncompleteObserved` (error with `usageIncomplete`) in the run.
- In the finally block, in both the quota (`providerLimit`) and `accountFailover` branches, after
  `closeProviderAttempt` and before `handleProviderLimit`: if neither flag is set, execution
  termination is verified, and `assessPreUsageProviderRefusal` qualifies, update the pod to
  `tokenTelemetryAccuracy: 'complete'` and (if NULL) `phaseTokenUsage: { [agentPhaseBucketKey(attempt)]:
  { inputTokens: 0, outputTokens: 0 } }`, and emit activity
  `Provider refused attempt #N (runtime/model) before any model usage; recorded zero token usage.`

#### 3. Early ledger gate
**File:** `packages/daemon/src/pods/provider-continuation.ts`
- New `assertContinuationBudgetAdmissible(podId)`: read `podRepo.taskExecutions?.snapshot(podId)`;
  if `budgetCheck.status` is `unavailable` or `exhausted`, throw `AutopodError(reason,
  'TASK_BUDGET_UNAVAILABLE' | 'TASK_BUDGET_EXHAUSTED', 409)`; for `unavailable` append the owner hint
  `Pod owner can run: ap accept-unmeasured-usage <podId> --reason "..."`.
- Call it at the top of `queueProviderContinuation` (before handoff/open attempt) and in
  `continueProvider` right after the active-run check (before draining/handoff).
- `handleProviderLimit` returns `'queued' | 'budget_blocked' | 'not_queued'`. On a budget gate error:
  keep the pod `paused/provider_limit`, set `failureReason` to the gate message, emit it as activity.
- **File:** `agent-event-consumption.ts` account-failover branch: do not transition to `failed` when
  `handleProviderLimit` returned `'budget_blocked'` (owner can reconcile and continue).
- **File:** `agent-execution-contracts.ts` — update the `handleProviderLimit` port type.

#### 4. Name the attempt
**File:** `packages/daemon/src/pods/task-execution-ledger.ts`
- Collect, for each row that sets `incompleteSpending` because of agent-accuracy/phase-null, a label
  `pod <id> provider attempt #<ordinal> (<runtime>/<model>, <outcome>)` from its latest settled
  `retained_provider_attempts` row (or `pod <id>` if none). Reason becomes
  `Task token accounting incomplete for <labels>; reconcile prior execution and phase telemetry before starting more budgeted work.`
  (other incompleteness causes keep the generic suffix without a name).
- Diagnostics add `<id>: provider attempt #N usage accepted as unmeasured by pod owner` for receipts (Phase 2).

### Success Criteria

#### Automated Verification
- [ ] New test (`provider-account-failover.test.ts`, budget set): zero-usage refusal → accuracy
  `complete`, budget `below_recorded_limit`, continuation queued, and a second
  `consumeAgentEvents` run is admitted (2 `task_agent_runs`, no accounting error).
- [ ] New test: refusal after a usage event → no target attempt, no requeue, pod `paused/provider_limit`,
  failure reason names `provider attempt #1`.
- [ ] New/updated unit tests for `assessPreUsageProviderRefusal` and ledger reason naming.
- [ ] `npx pnpm --filter @autopod/daemon exec vitest run <affected files>` passes.

---

## Phase 2: Owner "accept as unmeasured and continue"

### Changes Required

#### 1. Migration
**File:** `packages/daemon/src/db/migrations/276_unmeasured_usage_acceptances.sql`
- `unmeasured_usage_acceptances(id PK, pod_id, provider_attempt_ordinal, task_id, lifecycle_generation,
  accepted_by, authorization_basis CHECK = 'pod_owner', reason CHECK length 10..2000,
  prior_accuracy, recorded_input_tokens, recorded_output_tokens, recorded_cost_usd, accepted_at,
  UNIQUE(pod_id, provider_attempt_ordinal), FK (pod_id, ordinal) → provider_attempts ON DELETE CASCADE)`,
  append-only UPDATE/DELETE-abort triggers (delete trigger omitted if cascade must work — follow
  `134` pattern exactly: update-only trigger).

#### 2. Service
**File:** `packages/daemon/src/pods/unmeasured-usage-acceptance.ts`
- `createUnmeasuredUsageAcceptance({ db, podRepo, providerAttemptRepo, continueAfterAcceptance })`
  with `accept(podId, { reason, attemptOrdinal? }, principal: { oid })`:
  - 403 unless `principal.oid` non-empty and equals `pod.userId` (no role bypass).
  - 409 if termination unverified, active task run, active provider attempt, infrastructure
    blocker, status not `paused`/`failed`, accuracy not `partial`, or ledger budget not `unavailable`.
  - Target = latest settled provider attempt; 409 if `attemptOrdinal` given and differs.
  - Transaction: insert receipt; update pod `token_telemetry_accuracy='repaired'`, and zero/current
    agent phase bucket when phase usage is NULL.
  - After commit: if pod is `paused/provider_limit`, call `continueAfterAcceptance(podId)` which
    selects the failover target and calls `queueProviderContinuation` (gate re-checked). Returns
    `{ receipt, continuation: 'queued' | 'not_applicable' | 'unavailable', message? }`.
- **File:** `provider-continuation.ts` — export `continueAfterAcceptedUsage(podId)` using
  `selectProviderFailoverTarget` + last settled attempt classification.
- **Files:** `pod-manager.ts`, `pod-manager-facade.ts`, `pod-facade-ports.ts` — wire
  `acceptUnmeasuredUsage(podId, input, principal)`.

#### 3. Route
**File:** `packages/daemon/src/api/routes/pods.ts`
- `POST /pods/:podId/accept-unmeasured-usage`, zod body `{ reason: string 10..2000, attempt?: int>0 }`,
  principal from `request.user.oid`; AutopodError → status/code body like `continue-provider`.

### Success Criteria
#### Automated Verification
- [ ] Service tests: owner accept → receipt row, accuracy `repaired`, budget `below_recorded_limit`,
  diagnostic present, continuation queued; non-owner (incl. admin role) 403; wrong attempt 409;
  active run 409; accuracy complete 409; receipt table rejects UPDATE.
- [ ] Route test via `app.inject` (or existing pods route test harness): 400 on short reason,
  forwards oid.
- [ ] Migration applies in `createTestDb()`; no test hardcodes schema version.

---

## Phase 3: CLI

### Changes Required
- `packages/cli/src/api/client.ts`: `acceptUnmeasuredUsage(id, { reason, attempt? })`.
- `packages/cli/src/commands/pod.ts`: `ap accept-unmeasured-usage <id> --reason <text> [--attempt <n>]`,
  prints receipt + continuation outcome.
- Tests in `client.test.ts` / `pod.test.ts`.

### Success Criteria
#### Automated Verification
- [ ] CLI tests pass: `npx pnpm --filter @autopod/cli exec vitest run src/commands/pod.test.ts src/api/client.test.ts`.
- [ ] `npx pnpm build` then `npx turbo run typecheck lint` (or `npx pnpm lint` + package typecheck) pass.

## Testing Strategy

Unit: assessment edge cases (auth vs quota, usage present, activity present, multiple runs, missing
repos); ledger reason naming. Integration (real SQLite pod manager): failover regression, uncertain
block before re-preparation, owner acceptance + continuation. Existing suites:
`provider-account-failover`, `zero-work-failure*`, `task-execution-ledger`,
`reviewer-run-repository`, `provider-continuation*`, `agent-event-consumption*`.

### Manual Testing Steps
1. Local Docker daemon, profile with budget + Codex primary (out of credits) + Claude failover:
   failover starts without the accounting error; activity shows the zero-usage line.
2. Force a partial-usage refusal: pod parks `paused` immediately (no re-preparation), status names the
   attempt; owner runs `ap accept-unmeasured-usage` and the failover queues; a different user gets 403.

## Performance Considerations
One extra ledger snapshot per continuation queue — negligible.

## Migration Notes
Additive table `276_unmeasured_usage_acceptances.sql`; rollback = ignore table (older daemons do not
read it; pods marked `repaired` remain admissible, which matches the recorded owner decision).

## References
- Issue #646 (task brief)
- Research: `thoughts/shared/research/2026-11-22-646-failover-token-accounting.md`
- Precedents: `zero-work-failure-release.ts:61-70`, `claude-session-telemetry.ts:183-195`,
  `reviewer-run-repository.ts:283-333`
