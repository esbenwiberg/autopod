# Handover - registered-fowl

## Built

- Added shared Readiness Review contracts in `packages/shared/src/types/readiness.ts` and
  exported them through `@autopod/shared`.
- Added `Pod.readinessReview: ReadinessReview | null`.
- Added Zod schemas for readiness statuses, areas, source refs, area rows, findings,
  approval metadata, and nullable snapshots.
- Added migration `116_pod_readiness_review.sql` with nullable `pods.readiness_review`.
- Wired `PodRepository` to parse, update, list, and clear the compact JSON snapshot.
- Normalized pod API wire serialization so `readinessReview` is present as either `null`
  or the stored compact object.
- Added required tests for shared readiness shape, repository round-trip/clear, and API
  nullable/object response behavior.

## Deviations

- No meaningful deviations from brief scope.
- `wire-serializers.ts` was changed only to normalize absent readiness snapshots to `null`;
  it still does not expand or embed raw evidence.

## Contracts Downstream Pods Need

- Shared type entry point: `ReadinessReview` and related types are exported from
  `@autopod/shared`.
- Stored column: `pods.readiness_review` contains compact JSON or SQL `NULL`.
- Repository update path: `podRepo.update(id, { readinessReview })` stores a snapshot;
  `podRepo.update(id, { readinessReview: null })` clears it.
- API pod responses expose `readinessReview` as nullable camelCase.
- Readiness schemas use `.passthrough()` to tolerate unknown future fields while preserving
  the v1 compact contract.

## Files To Treat As Owned By This Brief

- `packages/shared/src/types/readiness.ts`
- `packages/shared/src/types/readiness.test.ts`
- `packages/daemon/src/db/migrations/116_pod_readiness_review.sql`
- Readiness-related fields in `packages/shared/src/types/pod.ts`,
  `packages/shared/src/schemas/pod.schema.ts`, `packages/daemon/src/pods/pod-repository.ts`,
  and `packages/daemon/src/api/wire-serializers.ts`

## Landmines

- Migration prefix `116` was available when this pod started; later branches must recheck before
  adding more migrations.
- This brief intentionally does not compute readiness, gate approval, add history, or add series
  storage. Downstream computation should update only the latest per-pod snapshot.
- Keep the stored payload compact. Link to Validation, Work, Logs, Diff, PR, Evidence, Quality,
  or Event surfaces via `sourceRefs`; do not embed raw logs, screenshots, diffs, scan output,
  action audit bundles, or PR check payloads.
