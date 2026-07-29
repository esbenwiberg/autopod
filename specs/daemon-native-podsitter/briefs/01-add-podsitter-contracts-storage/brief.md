---
title: "Add daemon Podsitter contracts and durable state"
touches:
  - packages/shared/src/types/podsitter.ts
  - packages/shared/src/types/events.ts
  - packages/shared/src/index.ts
  - packages/shared/src/schemas/
  - packages/daemon/src/db/migrations/131_daemon_podsitter.sql
  - packages/daemon/src/podsitter/podsitter-repository.ts
  - packages/daemon/src/podsitter/podsitter-repository.test.ts
  - packages/daemon/src/podsitter/activation.ts
  - packages/daemon/src/podsitter/activation.test.ts
  - packages/daemon/src/provider-accounts/provider-account-store.ts
  - packages/daemon/src/provider-accounts/provider-account-store.test.ts
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/system-sandbox/
  - packages/daemon/src/api/
  - packages/cli/
  - packages/desktop/
require_sidecars: []
---

## Task

Add the shared Podsitter configuration, activation, attention, decision, actor, action, provider-circuit, and event contracts plus durable SQLite repositories. Implement restart-safe attention leases/idempotency and activation evaluation for always-on and recurring windows. Protect a dedicated provider account from deletion while referenced by Podsitter configuration.

## Motivation

The current Pi extension keeps its ledger on one laptop. A daemon control loop needs durable authority, deduplication, provider state, and audit identity before any sandbox or action behavior can be added.

## Repository findings

- Current migrations end at prefix `130`; re-check immediately before writing and renumber this migration plus the contract artifact if another branch has advanced the sequence.
- `packages/daemon/src/scheduled-jobs/scheduled-job-manager.ts` already uses `cron-parser`, but Podsitter needs an active interval (cron occurrence plus duration), not a job fire.
- `packages/daemon/src/provider-accounts/provider-account-store.ts` already rejects deletion for profile and failover references; add Podsitter configuration as another inbound reference.
- `packages/daemon/src/pods/event-bus.ts` persists shared `SystemEvent` values and can carry new Podsitter lifecycle events later.

## Approved approach

Follow `purpose.md` and `design.md`. Add one migration containing `podsitter_config`, `podsitter_attention`, `podsitter_decisions`, `podsitter_action_audit`, `podsitter_provider_state`, and `system_sandbox_runs`. Store no credentials, raw prompts, full logs, or full diffs.

Expose repositories that transactionally:

- replace/update configuration while incrementing an authorization generation;
- acquire/release attention and provider-probe leases;
- supersede stale pending signatures;
- reserve one action idempotency key before execution;
- persist decision/action/provider/sandbox outcomes;
- recover expired leases after restart.

Activation supports `always` or `recurring { cronExpression, durationMinutes, timeZone }`, plus `enabled`, optional `authorizedUntil`, and optional profile scope. Validate five-field cron, positive bounded duration, and IANA timezone. Evaluate cross-midnight windows from the most recent occurrence without generating catch-up actions.

Define a discriminated `OperatorActor` and full-parity `PodsitterAction` enum, but do not change PodManager behavior in this brief.

## Scope boundaries

Do not start timers, invoke an LLM, spawn containers, execute pod actions, or add HTTP/CLI/desktop surfaces. Do not add a `Profile` field. Keep existing provider-account and scheduled-job behavior unchanged.

## Constraints

- Every mutating repository method must be transactional where a concurrent tick could duplicate work.
- Leases must use durable expiry timestamps; process-local booleans are insufficient.
- Configuration generation must change on disable, activation/config changes, and dedicated-account changes.
- Public configuration/decision types must not expose provider credentials.
- Event payloads and persisted action arguments must use redacted/bounded fields.
- Provider account deletion must fail with a specific conflict while referenced and succeed after the reference is removed.

## Test expectations

Prove activation for always-on, disabled, expired, recurring, cross-midnight, DST/timezone, and inactive cases. Prove that rebuilding repositories over the same database restores pending attention/provider state, expired leases can be reacquired, active leases cannot, duplicate action keys cannot be reserved, and new signatures supersede stale pending signatures. Prove provider account deletion reference protection.

## Required-fact sanity

- An in-memory-only ledger must fail `fact-durable-attention-ledger` after repository reconstruction.
- A cron implementation that treats the occurrence as an instant rather than an interval must fail `fact-activation-window-evaluation`.
- A repository without a unique action key/lease condition must fail `fact-action-idempotency` under duplicate acquisition.
- A provider-account delete path unaware of Podsitter references must fail `fact-dedicated-account-reference`.

## Risks

SQLite time comparisons and cron timezone/DST behavior can create duplicate windows. Normalize persisted timestamps to ISO UTC and preserve the occurrence identity used for per-window budgets. Do not reuse a migration prefix if main advances before implementation.

## Wrap-up

Before finishing:
1. Re-check migration prefixes.
2. Run focused shared/daemon tests and typecheck.
3. Run the profile finish prompt if configured.
4. Commit and push.
