# Handover - creepy-tahr

## Built

- Added `packages/daemon/src/pods/readiness-review.ts`, a focused daemon service for
  per-pod Readiness Review derivation and single-PR series rollups.
- The service derives top-level `ready`, `needs_review`, `risky`, and `waived` from
  existing validation/advisory QA, security scan, action audit, network/event, scope,
  quality, worktree, and PR state. It stores compact source refs only.
- Wired pod-manager refreshes when pods enter `validated`, `review_required`, or
  `failed`, when deferred advisory QA is merged into the latest validation result, when
  advisory QA is in flight, and immediately before approval.
- Added small repository helpers:
  - `ActionAuditRepository.getSafetySummary(...)`
  - `EventRepository.countForSession(...)`
  - `ScanRepository.getLatestForPod(...)`
- Passed the existing `qualityScoreRepo` into pod-manager as an optional dependency.
- Added required focused tests in `readiness-review.test.ts` and advisory refresh
  coverage in `pod-manager.test.ts`.

## Deviations

- Biome formatting also touched three parent-brief readiness files:
  `packages/shared/src/types/readiness.ts`,
  `packages/shared/src/types/readiness.test.ts`, and
  `packages/shared/src/schemas/pod.schema.ts`. These are mechanical formatting-only
  changes required for root lint to pass.
- `qualityScoreRepo` was added to `PodManagerDependencies`, outside the advisory file
  list but needed for the brief's quality input. It is optional, so existing tests and
  deployments without a quality repository still compute readiness.

## Contracts Downstream Pods Need

- Per-pod snapshots are persisted through `readinessService.refreshPodReadiness(...)`
  and still use the shared `ReadinessReview` shape from Brief 01.
- Series Readiness is computed, not stored, via
  `deriveSeriesReadiness(...)` / `createReadinessService(...).computeSeriesReadiness(...)`.
  It returns a daemon-local `SeriesReadinessReview` with `scope: 'series'`,
  `seriesId`, `memberStatuses`, and aggregated findings.
- Snapshot refresh is best-effort in pod-manager: failures are logged and do not change
  validation, advisory QA, PR creation, retry, or approval semantics.
- Advisory QA in flight is represented as area `advisory_qa` with status
  `not_available` and a warning finding; the eventual advisory result replaces that
  finding when persisted.

## Files To Treat As Owned By This Brief

- `packages/daemon/src/pods/readiness-review.ts`
- `packages/daemon/src/pods/readiness-review.test.ts`
- Readiness refresh calls in `packages/daemon/src/pods/pod-manager.ts`
- Readiness assertions in `packages/daemon/src/pods/pod-manager.test.ts`

## Landmines

- Passive missing optional evidence, such as no quality score or no optional repository,
  does not make a pod `needs_review`. Explicit missing blocking validation and advisory
  QA in flight do.
- `validationWaiver` and `skipValidation` make the validation area `waived`; a separate
  hard risk such as blocked PR or compromised worktree still makes the top-level status
  `risky`.
- Approval gating is not implemented here. Brief 03 must consume the persisted snapshot
  and enforce reason/auto-approve behavior.
- Approval refresh currently recomputes readiness but does not wait for in-flight
  advisory QA. That wait belongs to Brief 03.
