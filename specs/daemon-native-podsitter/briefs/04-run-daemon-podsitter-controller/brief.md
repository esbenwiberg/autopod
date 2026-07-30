---
title: "Run the daemon Podsitter controller and API"
touches:
  - packages/daemon/src/podsitter/
  - packages/daemon/src/index.ts
  - packages/daemon/src/api/server.ts
  - packages/daemon/src/api/routes/podsitter.ts
  - packages/daemon/src/api/routes/podsitter.test.ts
  - packages/shared/src/types/events.ts
  - packages/shared/src/index.ts
  - packages/daemon/src/notifications/
does_not_touch:
  - packages/cli/
  - packages/desktop/
  - packages/mobile-web/
  - packages/escalation-mcp/
require_sidecars: []
---

## Task

Implement and start the daemon-native Podsitter reconciliation service. Build bounded evidence, invoke the dedicated-account system decision sandbox, apply activation/policy/idempotency checks, execute one typed action, recover gracefully from provider limits, expose authenticated configuration/status/history routes, and emit durable events and notifications.

## Motivation

Briefs 01–03 provide durable state, isolated judgment, and typed actor-aware actions. This brief joins them into the always-on feature that replaces the laptop dependency while preserving evidence-based autonomy and safe control-plane ownership.

## Repository findings

- `issue-watcher-service.ts` is the closest event-plus-periodic reconciliation precedent.
- `scheduled-job-manager.ts` provides cron parsing but its fire/catch-up semantics must not be reused for authorization windows.
- `readiness-review.ts`, validation history, event repository, PodManager status, diff/worktree interfaces, and log routes contain the evidence currently collected by the Pi skill.
- `provider-error-classifier.ts` already produces sanitized rate-limit/quota/auth/outage categories.
- Existing strict `autoApprove` behavior can continue without LLM judgment when the decision provider is unavailable, but non-ready approvals and all other interventions require a fresh decision.

## Approved approach

Implement the architecture and exact decisions in `design.md`.

The service subscribes to relevant pod/escalation/validation/readiness events and performs a periodic sweep for staleness and activation/provider-probe edges. It writes stable attention signatures, acquires durable leases, and processes serially. On startup it reconciles expired leases, current attention, leaked system sandboxes, current activation, and provider circuit state.

Build a versioned redacted evidence packet with stable references and truncation markers. Include current status/timestamps, escalations, readiness, validation/facts/history, task/contract/summary, series graph, bounded logs/events/diff/touched-file excerpts, provider attempts/costs, attempt caps, worktree state, and prior sitter actions. Never include provider credentials, daemon tokens, raw secret-bearing configuration, or unbounded content.

Prompt the decision sandbox with versioned Podsitter policy and untrusted-delimited evidence. Accept one strict decision. Re-read configuration and pod state, recompute signature, reserve the action, and use the Brief 03 executor. Record model output, evidence hash/version, telemetry, policy result, action outcome, reason, remaining risk, and stop condition.

Implement full activation support: disabled by default, always-on or recurring cron-plus-duration with timezone, optional expiry, optional profile scope, configurable window ceilings, and atomic generation-changing kill switch. Manual check while inactive gathers/statuses attention but executes nothing.

Implement the durable provider circuit from `design.md`. Honor Retry-After/reset evidence and bounded category-specific backoff. Provider failures never consume pod or sitter action attempts. Pending attention remains durable. On successful probe, rebuild current evidence and drain serially; never execute stale queued decisions. While limited, only strict ready/pass/sound/no-threat deterministic approval may continue.

Expose authenticated admin/operator API routes for redacted config/status, configure, enable, disable, check, provider probe, and paginated decision history. Block incompatible/unauthenticated dedicated targets and missing hosted system image at configuration/enable time where determinable. Emit rate-limited events/notifications for consequential actions, provider limited/recovered, expiry/disable, and cleanup leaks.

## Scope boundaries

Do not build CLI, desktop, or mobile surfaces. Do not redirect the existing local Pi extension. Do not add per-action customization or target-provider fallback. Do not persist raw prompts/full evidence.

## Constraints

- One inference at a time and one action per decision.
- State-change signatures must not vary on every polling tick after a stale threshold is crossed.
- New evidence supersedes stale pending work.
- Disable/expiry/config generation changes between inference and execution prevent action.
- Provider limit recovery is durable across restart and does not hammer the provider.
- Provider probe success only opens the circuit; each pending pod gets fresh evidence and a fresh decision.
- Strict deterministic approval retains all current ready/pass/worktree/escalation/blocker conditions.
- Full-parity force/skip/recovery actions still obey Brief 03 policy and sitter budgets.
- API responses redact provider credentials and bounded evidence remains sanitized.
- Background failures are fail-soft for normal pod lifecycle and visible to operators.

## Test expectations

Use fake clock, event bus, repositories, decision runner, action executor, and pod evidence dependencies. Prove event/sweep deduplication, activation edges, stale detection, signature supersession, serial decisions, current-state race rejection, full decision-to-action flow, kill switch, restart recovery, provider-limit backoff/recovery, deterministic approval during outage, and fresh evidence after recovery. Test injected instructions in logs/diffs cannot change schema or bypass policy. Add route tests for role auth, validation, redaction, enable/disable generation, read-only check, probe, and history pagination.

## Required-fact sanity

- A process-local poller must fail `fact-restart-safe-controller` after reconstructing the service.
- A quota loop that repeatedly spawns sandboxes or consumes action attempts must fail `fact-provider-limit-recovery`.
- A recovery path executing the decision/evidence captured before the limit must fail `fact-fresh-evidence-after-recovery`.
- A service that executes after disable or expiry during inference must fail `fact-kill-switch-race`.
- A model prompt capable of directly invoking actions or returning unknown action data must fail `fact-untrusted-evidence-boundary`.

## Risks

The evidence builder can accidentally create oversized prompts or include secrets. Bound each source independently and test redaction/truncation. Event storms can create duplicate work; leases, signatures, and serial processing are mandatory. Full parity makes actor and audit correctness a release blocker. Provider reset timestamps differ by runtime, so keep opaque sanitized evidence and deterministic fallback backoff.

## Wrap-up

Before finishing:
1. Run focused Podsitter service/evidence/route tests.
2. Run daemon/shared build, typecheck, and tests.
3. Exercise migration uniqueness and restart fixtures.
4. Run the profile finish prompt if configured.
5. Commit and push.
