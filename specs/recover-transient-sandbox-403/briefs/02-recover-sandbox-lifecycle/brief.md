---
title: "Recover one safe transient sandbox lifecycle failure"
touches:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/pods/readiness-review.ts
  - packages/daemon/src/pods/readiness-review.test.ts
does_not_touch:
  - packages/shared/src/constants.ts
  - packages/shared/src/types/profile.ts
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/containers/azure-sandbox-api-client.ts
  - packages/daemon/src/pods/state-machine.ts
  - packages/daemon/src/pods/local-reconciler.ts
  - packages/desktop/
  - packages/mobile-web/
require_sidecars: []
---

## Task

Consume the structured sandbox infrastructure contract to perform exactly one safe,
30-second, fresh-sandbox recovery before agent execution. Fail closed on ambiguity or cleanup
failure, route explicit Resume back through the original agent task, and make readiness describe
infrastructure unavailability without claiming code risk.

## Why

Azure owns the incident, but the current generic catch terminates recoverable pods, attributes
the failure to the provider, and makes Resume skip a task that never ran. A lifecycle-level
recovery can handle the transient case without weakening agent-work safety.

## Research summary

Read `../../../research.md` and `../../../plan.md` before coding, plus the brief-01 handoff. The
queue already supports `requeueAfterCurrent()`, lifecycle generation fences stale work, restart
recovery provides a fresh-container precedent, and validation has structured infrastructure
retry semantics. `lastAgentEventAt` is not agent evidence because bootstrap status emissions
also update it.

## Plan

Observe whether the runtime iterator yields any event and combine that with persisted session,
provider-attempt, token, task-summary, validation, PR, and worktree evidence. For an eligible
typed failure, prove old-sandbox deletion, persist one recovery and its cooldown, requeue safely,
then provision a different sandbox. Exhaustion remains failed. Eligible explicit Resume clears
the budget and starts the original agent task rather than validation-only recovery.

## Checkpoints

1. Add the runtime-event evidence gate and focused classification helper.
2. Add lifecycle-fenced cleanup, persisted cooldown, and deferred requeue.
3. Add exhaustion, provider-attempt, and explicit Resume behavior.
4. Add readiness differentiation and regression coverage.

## Touches

- `packages/daemon/src/pods/pod-manager.ts`
- `packages/daemon/src/pods/pod-manager.test.ts`
- `packages/daemon/src/pods/readiness-review.ts`
- `packages/daemon/src/pods/readiness-review.test.ts`

## Does not touch

- `packages/shared/src/constants.ts`
- `packages/shared/src/types/profile.ts`
- `packages/daemon/src/db/migrations/`
- `packages/daemon/src/containers/azure-sandbox-api-client.ts`
- `packages/daemon/src/pods/state-machine.ts`
- `packages/daemon/src/pods/local-reconciler.ts`
- `packages/desktop/`
- `packages/mobile-web/`

## Constraints

- Honor `../../../design.md#recovery-flow` and the confirmed one-recovery safety boundary.
- Production cooldown is 30 seconds and must survive daemon restart through the persisted
  timestamp. Add a dependency seam so tests do not sleep.
- Increment lifecycle generation before awaiting cleanup or changing queue ownership, and recheck
  ownership after the cooldown.
- Never overwrite an uncertain old sandbox ID. Automatic reprovisioning requires confirmed
  deletion or absence.
- The host worktree is authoritative only when no runtime event or other agent execution evidence
  exists and it is not compromised.
- Close a provider attempt that never reached runtime execution as aborted, not failed/unknown.
- Keep ordinary failed-pod Resume, validation infrastructure Resume, Rework, and readiness
  behavior unchanged outside the new structured failure.
- Do not add a status or automatic execution-target/region fallback.

## Test expectations

Update `pod-manager.test.ts` with distinct container identities and a zero-delay seam. Prove one
eligible automatic retry, terminal exhaustion without a third sandbox, no retry after any runtime
event, no retry when old-sandbox cleanup is uncertain, lifecycle fencing, correct provider-attempt
outcome, and explicit Resume spawning the original task. Update `readiness-review.test.ts` with a
paired comparison between structured infrastructure unavailability and an ordinary pod lacking
validation.

## Risks / pitfalls

- Do not call ordinary `enqueue()` while the current pod ID is active; use the deferred requeue
  seam.
- Avoid checkpointing or copying a failed sandbox over the clean host worktree when no agent ever
  ran.
- The cooldown gate must not resume after a concurrent Kill/Rework changes lifecycle generation.
- A broad `statusCode === 403` check would retry real RBAC failures; require the typed contract.
- Do not suppress unrelated risky readiness findings when infrastructure is also unavailable.

## Wrap-up

Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
