---
title: "Add actor-aware typed Podsitter interventions"
touches:
  - packages/shared/src/types/pod.ts
  - packages/shared/src/types/escalation.ts
  - packages/shared/src/types/readiness.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/api/routes/pods.ts
  - packages/daemon/src/api/routes/pods.test.ts
  - packages/daemon/src/podsitter/action-executor.ts
  - packages/daemon/src/podsitter/action-executor.test.ts
  - packages/daemon/src/worktrees/pr-body-builder.ts
  - packages/daemon/src/worktrees/pr-body-builder.test.ts
does_not_touch:
  - packages/daemon/src/podsitter/podsitter-service.ts
  - packages/daemon/src/system-sandbox/
  - packages/cli/
  - packages/desktop/
require_sidecars: []
---

## Task

Make operator interventions carry explicit human, automation, or Podsitter provenance and add a narrow typed action executor covering the full current Pi Podsitter repertoire. Preserve all existing PodManager state-machine checks and human API behavior while removing hardcoded claims that AI/automation actions were human.

## Motivation

A daemon Podsitter cannot safely call raw HTTP endpoints or be recorded as `human`. The control plane needs one internal execution boundary that accepts only the shared discriminated action contract, applies deterministic preconditions/budgets, invokes existing services, and records the actual actor and outcome.

## Repository findings

- `ApproveSessionOptions` currently has only an `automation` boolean.
- Fact waivers, force approval, skip validation, escalation responses, and related activity text hardcode `human` in several `pod-manager.ts` paths.
- `EscalationResponse.respondedBy` already permits `human | ai`, but lacks durable decision identity.
- Existing API routes have authenticated `request.user` context and must continue to behave as human actions.
- PodManager already owns almost all full-parity actions; daemon-only actions should be exposed through narrow methods rather than HTTP self-calls.

## Approved approach

Thread the shared `OperatorActor` contract from Brief 01 through mutating operator methods. Existing public APIs construct a human actor from authenticated request context; existing automatic approval uses an automation actor. Podsitter will later pass `{ type: 'podsitter', decisionId, providerAccountId, model }`.

Add `PodsitterActionExecutor.execute({ podId, decision, actor, activationGeneration, windowId })`. It validates the action's discriminated arguments, re-reads the pod and policy-relevant state, verifies the attention signature/current action reservation supplied by the repository, applies fixed sitter budgets from `design.md`, invokes one typed PodManager/service method, and persists a redacted action result. It must not expose arbitrary command/URL/path execution.

Map all full-parity actions listed in `design.md`, including messages, validation overrides, budget/kick/revalidation operations, fact waivers, PR recovery, update-from-base, credential/tool recovery, worktree recovery, force/skip/complete, and manual-fix spawning. Existing state-machine errors remain authoritative and become audited `not_executed` results rather than retries.

Update validation waiver, escalation, event/activity, readiness, and PR-body provenance so Podsitter decisions are named accurately. Preserve backward-compatible serialized fields where possible; add actor metadata rather than erasing historical `waivedBy` strings.

## Scope boundaries

Do not start a Podsitter timer, collect evidence, invoke the decision sandbox, add Podsitter configuration routes, or build clients. Do not weaken existing operator endpoint auth or PodManager transition checks. Do not add generic `execute_action`, shell, or raw HTTP support.

## Constraints

- Existing human routes must still produce human provenance from `request.user`.
- Existing `autoApprove` must produce automation provenance.
- Podsitter provenance must include decision id and must never say human.
- Last-resort actions require non-empty reason, evidence references, remaining risk, and the action-specific preconditions from `design.md`.
- The executor performs at most one action per call and consumes a reservation exactly once.
- Secrets are excluded from persisted action arguments and activity text.
- A stale activation generation, attention signature, state, or duplicate reservation fails before side effects.
- Keep repository status transitions through `updateStatus()`/transition helpers; never assign status directly.

## Test expectations

Prove human and automation behavior remains intact. Prove Podsitter fact waiver, force approval, skip validation, escalation response, and ordinary approval carry Podsitter actor identity into durable evidence and PR/readiness output. Table-test every full-parity action enum mapping, invalid arguments, invalid status, stale generation/signature, duplicate action, and last-resort evidence requirements. Prove unknown actions and arbitrary command-shaped arguments fail closed.

## Required-fact sanity

- A force-approve path still writing `waivedBy: human` for a Podsitter actor must fail `fact-podsitter-actor-provenance`.
- An executor missing one full-parity enum mapping must fail `fact-full-parity-action-map`.
- An executor dispatching before current-signature/generation checks must fail `fact-action-race-guard`.
- An executor accepting `command`, `url`, or unknown action data must fail `fact-no-open-ended-actions`.

## Risks

`pod-manager.ts` has many internal automation callers; changing signatures can accidentally relabel existing behavior or break tests. Add backward-compatible defaults only at trusted human API boundaries, not inside the executor. Force actions affect downstream readiness and PR text, so verify actor propagation end-to-end.

## Wrap-up

Before finishing:
1. Run focused PodManager, route, executor, readiness, and PR-body tests.
2. Run daemon/shared typecheck.
3. Run the profile finish prompt if configured.
4. Commit and push.
