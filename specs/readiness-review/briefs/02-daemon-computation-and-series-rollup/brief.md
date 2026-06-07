---
title: "Compute pod and series Readiness Review"
touches:
  - packages/daemon/src/pods/readiness-review.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/pods/pod-repository.ts
  - packages/daemon/src/pods/event-repository.ts
  - packages/daemon/src/security/scan-repository.ts
  - packages/daemon/src/actions/audit-repository.ts
does_not_touch:
  - packages/cli/
  - packages/desktop/
  - packages/daemon/src/api/routes/pods.ts
---

## Task

Implement daemon-side readiness computation from existing evidence and persist
the latest per-pod snapshot at the decision points defined in
`specs/readiness-review/design.md`.

Add a focused Readiness service rather than spreading derivation logic across
routes. It should compute:

- per-pod Readiness Review snapshots;
- single-PR Series Readiness rollups over existing `series_id` member pods.

The service should read existing validation, advisory QA, security, action,
network/event, quality, worktree, and PR state. It must not change the semantics
of those systems.

## Touches

- `packages/daemon/src/pods/readiness-review.ts` - new computation service and
  testable pure helpers for status derivation.
- `packages/daemon/src/pods/pod-manager.ts` - call refresh after validation,
  deferred advisory merge, skip/waiver/force-approve, status transitions to
  `failed`/`review_required`/`validated`, and immediately before approval.
- `packages/daemon/src/pods/pod-manager.test.ts` - status derivation, refresh
  hook, advisory, and rollup coverage.
- `packages/daemon/src/pods/pod-repository.ts` - use existing
  `getPodsBySeries(...)` for rollups; add any small helper needed to update the
  snapshot.
- `packages/daemon/src/pods/event-repository.ts` - read pod-scoped events needed
  for denied egress and safety findings if no helper already exists.
- `packages/daemon/src/security/scan-repository.ts` - read latest scan result.
- `packages/daemon/src/actions/audit-repository.ts` - verify the action audit
  chain and detect quarantine/PII metadata.

## Does Not Touch

Do not add new blocking validation phases. Do not make advisory QA block
validation, retries, or PR creation. Do not add new action/security/network
drilldown routes. Do not write a series table or historical backfill job.

## Constraints

- Before `validated`, `review_required`, or `failed`, readiness can be absent or
  pending; do not emit noisy progressive findings.
- Scanner warnings, scanner errors, advisory QA concerns/errors, denied egress,
  scope drift, low quality, and action quarantine/PII are `needs_review`.
- Failed/unknown blocking validation, invalid action audit chain, compromised
  worktree, and blocked PR gate are `risky`.
- Validation waiver, skipped validation, and force-approve paths are `waived`
  unless a separate non-waiver hard risk makes the top-level status `risky`.
- Advisory QA in flight is `not_available` and top-level `needs_review` for
  display; approval waiting is implemented in Brief 03.
- Missing member snapshots in a single-PR series rollup produce a
  `needs_review` finding. Do not backfill old pods.
- Source refs must point to existing surfaces only.

## Test Expectations

- Clean validation/security/actions/network/scope/quality/advisory/PR inputs
  produce top-level `ready`.
- Each `needs_review` input produces the correct area finding without becoming
  `risky`.
- Each `risky` input produces top-level `risky`.
- Waiver/skip/force-approve inputs produce `waived` unless a separate hard risk
  exists.
- Deferred advisory QA completion refreshes the persisted snapshot.
- Single-PR rollup uses all member pods and marks missing old snapshots as
  `needs_review`.
- Branch/no-PR dependencies and single-PR member pods are not stopped by
  readiness findings.

## Wrap-up

Before finishing:

1. Run focused readiness and pod-manager tests.
2. Run `npx pnpm --filter @autopod/daemon test -- pod-manager.test.ts -t readiness`.
3. Run `npx pnpm --filter @autopod/daemon test`.
4. Commit and push.
