---
title: "Add Readiness Review types and pod persistence"
touches:
  - packages/shared/src/types/
  - packages/shared/src/schemas/pod.schema.ts
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/pod-repository.ts
  - packages/daemon/src/pods/pod-repository.test.ts
  - packages/daemon/src/api/wire-serializers.ts
  - packages/daemon/src/api/routes/pods.test.ts
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/desktop/
  - packages/cli/
---

## Task

Introduce the durable Readiness Review shape and persist the latest per-pod
snapshot on the `pods` row.

Add shared exported types for Readiness status, area status, areas, findings,
source refs, and approval metadata. Add an optional nullable readiness field to
the shared pod type and wire schemas if needed.

Add one nullable SQLite column on `pods`, for example:

```sql
ALTER TABLE pods ADD COLUMN readiness_review TEXT;
```

Use the next migration prefix at implementation time. Do not assume `116` is
still available without checking the migrations directory first.

## Touches

- `packages/shared/src/types/` - add the Readiness Review contracts and export
  them through the existing shared type barrel.
- `packages/shared/src/schemas/pod.schema.ts` - accept optional/null readiness
  data if the schema validates pod response shapes.
- `packages/daemon/src/db/migrations/` - add the nullable JSON column.
- `packages/daemon/src/pods/pod-repository.ts` - parse, serialize, update, and
  clear the readiness JSON.
- `packages/daemon/src/pods/pod-repository.test.ts` - prove insert/update/read
  and clearing behavior.
- `packages/daemon/src/api/wire-serializers.ts` - pass through readiness without
  raw evidence expansion.
- `packages/daemon/src/api/routes/pods.test.ts` - prove API null/object response
  behavior if no narrower serializer test exists.

## Does Not Touch

Do not implement status computation, approval gating, CLI display, or Desktop UI
in this brief. Do not add a readiness history table. Do not add a series table.

## Constraints

- The stored snapshot must be nullable for old pods.
- The JSON payload must stay compact: no raw logs, screenshots, full diffs,
  action audit bundles, security scan output, or PR check payloads.
- Unknown future fields should be tolerated on read when practical, because old
  clients may read newer snapshots.
- Clearing the column with `null` must be supported for tests and rollback.
- Migration prefix collisions are forbidden. Check the latest prefix before
  writing the migration.

## Test Expectations

- Shared type/schema tests compile and accept `ready`, `needs_review`, `risky`,
  `waived`, `not_applicable`, and `not_available` in the intended places.
- Pod repository round-trips a full compact snapshot with areas, findings,
  source refs, and approval metadata.
- Pod repository can clear the snapshot to `null`.
- API pod responses expose `readinessReview: null` for old pods and an object for
  pods with a stored snapshot.

## Wrap-up

Before finishing:

1. Run focused shared and daemon repository tests.
2. Run `npx pnpm --filter @autopod/shared test`.
3. Run `npx pnpm --filter @autopod/daemon test -- pod-repository.test.ts`.
4. Commit and push.
