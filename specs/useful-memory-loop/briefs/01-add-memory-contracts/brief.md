---
title: "Add memory contracts and migration"
touches:
  - packages/shared/src/types/memory.ts
  - packages/shared/src/types/task-summary.ts
  - packages/shared/src/types/events.ts
  - packages/shared/src/types/analytics.ts
  - packages/shared/src/index.ts
  - packages/daemon/src/db/migrations/105_memory_learning.sql
  - packages/daemon/src/db/migrate.test.ts
  - packages/daemon/src/test-utils/mock-helpers.ts
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/system-instructions-generator.ts
  - packages/escalation-mcp/
  - packages/desktop/
---

## Task

Add the shared data contracts and schema needed for the useful memory loop. Durable memory entries keep `content` as markdown and gain structured metadata: `kind`, `tags`, `appliesWhen`, `avoidWhen`, `confidence`, `sourceEvidence`, and `impactSummary`. Add candidate/update-candidate types, usage event types, and a memory analytics response type. Extend plan/task-summary contracts so agents can report intended and final memory use.

Create migration `105_memory_learning.sql` after checking the highest existing migration prefix immediately before implementation. It must preserve legacy rows and default them to a readable note-style shape rather than hiding them.

## Touches

- `packages/shared/src/types/memory.ts` - extend `MemoryEntry` and add candidate, source-evidence, usage, and selection types.
- `packages/shared/src/types/task-summary.ts` - add final per-memory outcome reporting: `applied`, `not_applicable`, `harmful_stale`, with reason.
- `packages/shared/src/types/events.ts` - add candidate-created/updated events.
- `packages/shared/src/types/analytics.ts` - add `MemoryAnalyticsResponse`.
- `packages/shared/src/index.ts` - re-export the new contracts.
- `packages/daemon/src/db/migrations/105_memory_learning.sql` - add metadata, candidates, usage events, and supporting indexes.
- `packages/daemon/src/db/migrate.test.ts` - assert the new schema applies cleanly.
- `packages/daemon/src/test-utils/mock-helpers.ts` - keep test DB migration helpers aligned if needed.

## Does not touch

- `packages/daemon/src/pods/pod-manager.ts` - orchestration comes later.
- `packages/daemon/src/pods/system-instructions-generator.ts` - injection comes later.
- `packages/escalation-mcp/` - tool schemas come later.
- `packages/desktop/` - client mirrors come later.

## Constraints

- Preserve `MemoryScope = global | profile | pod`.
- Do not generate new global candidates in schema defaults. Existing global memories remain supported.
- Existing rows must remain approved/unapproved exactly as they were.
- Use nullable/defaulted fields for legacy compatibility.
- Follow `design.md` -> Contracts for field names and semantics.

## Test expectations

Add a focused migration/schema test that applies all migrations to an in-memory DB, verifies legacy memory rows survive, and verifies the candidate/usage tables and indexes exist. The repository behavior is covered in brief 02.

## Risks / pitfalls

- Migration prefix collisions are silent bugs in this repo. Check `ls packages/daemon/src/db/migrations/ | tail -5` immediately before adding the migration.
- The desktop still decodes legacy memory names like `createdBySessionId`; keep wire compatibility in the shared shape.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
