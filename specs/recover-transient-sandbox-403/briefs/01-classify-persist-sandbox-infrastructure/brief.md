---
title: "Classify and persist transient sandbox infrastructure failures"
touches:
  - packages/shared/src/types/pod.ts
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/containers/sandbox-api-client.ts
  - packages/daemon/src/containers/azure-sandbox-api-client.ts
  - packages/daemon/src/containers/azure-sandbox-api-client.test.ts
  - packages/daemon/src/pods/pod-repository.ts
  - packages/daemon/src/pods/pod-repository.test.ts
does_not_touch:
  - packages/shared/src/constants.ts
  - packages/daemon/src/pods/state-machine.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/readiness-review.ts
  - packages/desktop/
  - packages/mobile-web/
require_sidecars: []
---

## Task

Create the typed and persisted contract that distinguishes exhausted empty Azure Sandbox
data-plane 403 responses from deterministic authorization failures. Preserve safe Azure
diagnostics and add legacy-safe pod storage for the current infrastructure failure and its
dedicated automatic-recovery count.

## Why

The transport layer knows that an empty data-plane 403 is transient, but currently erases
that distinction after retries exhaust. Lifecycle recovery cannot act safely or present the
right failure without a durable machine-readable cause.

## Research summary

Read `../../../research.md` and `../../../plan.md` before coding. The current adapter retries
empty data-plane 403s six times, then throws generic `AZURE_SANDBOX_HTTP_ERROR`; non-empty and
ARM 403s are deterministic. Pod persistence is SQLite-backed and the highest migration prefix
was 139 during research, but it must be rechecked immediately before creating a migration.

## Plan

Add a daemon-local typed sandbox infrastructure error for exhausted empty data-plane 403,
carrying retryability and the existing allowlisted diagnostics. Extend the shared Pod contract
with the approved nullable structured failure and non-negative recovery count, then migrate and
round-trip both fields with null/zero legacy defaults.

## Checkpoints

1. Add the typed adapter error and make the existing empty/non-empty tests discriminate it.
2. Add the shared pod shape and the next collision-free migration.
3. Add repository read/update support and default/round-trip tests.

## Touches

- `packages/shared/src/types/pod.ts`
- `packages/daemon/src/db/migrations/`
- `packages/daemon/src/containers/sandbox-api-client.ts`
- `packages/daemon/src/containers/azure-sandbox-api-client.ts`
- `packages/daemon/src/containers/azure-sandbox-api-client.test.ts`
- `packages/daemon/src/pods/pod-repository.ts`
- `packages/daemon/src/pods/pod-repository.test.ts`

## Does not touch

- `packages/shared/src/constants.ts`
- `packages/daemon/src/pods/state-machine.ts`
- `packages/daemon/src/pods/pod-manager.ts`
- `packages/daemon/src/pods/readiness-review.ts`
- `packages/desktop/`
- `packages/mobile-web/`

## Constraints

- Read the shared contract in `../../../design.md#contracts`; preserve its semantics even if
  local naming is adjusted.
- Throw the new type only for an exhausted empty data-plane 403. Do not reclassify non-empty or
  ARM failures and do not alter the six-attempt retry count.
- Persist only allowlisted response diagnostics; never persist authorization headers, response
  bodies, tokens, or credentials.
- Recheck `packages/daemon/src/db/migrations/` and use the next unique numeric prefix. Duplicate
  prefixes are a silent migration bug.
- Legacy rows must deserialize to `infrastructureFailure: null` and
  `infrastructureRecoveryCount: 0`.

## Test expectations

Update `azure-sandbox-api-client.test.ts` so exhausted empty 403s have the new stable code,
retryability, and safe diagnostics while non-empty RBAC 403s remain generic/deterministic.
Update `pod-repository.test.ts` to prove legacy defaults and exact round-trip of scheduled,
exhausted, ambiguous, and cleanup-unconfirmed failure dispositions.

## Risks / pitfalls

- Reading a `Response` body twice can consume it. Classify and build diagnostics without losing
  the content needed by deterministic errors.
- Avoid making every Pod fixture noisy if the repository's compatibility pattern supports a
  safe optional-at-input/required-at-read boundary.
- Do not store redundant state whose values can contradict the authoritative recovery count and
  disposition.

## Wrap-up

Before finishing:
1. Follow the profile finish prompt, if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
