# Handover: safe-marten — Brief 01 (Shared Contracts & Migration)

## What was built

- **`packages/shared/src/types/memory.ts`** — Extended `MemoryEntry` with seven new nullable/defaulted fields (`kind`, `tags`, `appliesWhen`, `avoidWhen`, `confidence`, `sourceEvidence`, `impactSummary`). Added `MemoryKind`, `MemorySourceEvidence`, `MemoryCandidate`, `MemoryCandidateStatus`, `MemoryCandidateAction`, `MemoryUsageKind`, `MemoryUsageOutcome`, `MemoryUsageEvent`.

- **`packages/shared/src/types/task-summary.ts`** — Added `MemoryOutcomeItem` and `memoryOutcomes?: MemoryOutcomeItem[]` to `TaskSummary`.

- **`packages/shared/src/types/events.ts`** — Added `MemoryCandidateCreatedEvent` and `MemoryCandidateUpdatedEvent` to the `SystemEvent` union; imported `MemoryCandidate`.

- **`packages/shared/src/types/analytics.ts`** — Added `MemoryAnalyticsResponse` at the end of the file.

- **`packages/shared/src/index.ts`** — Re-exported all new types.

- **`packages/daemon/src/db/migrations/105_memory_learning.sql`** — Adds 7 columns to `memory_entries` (all nullable/defaulted for legacy compatibility), creates `memory_candidates` and `memory_usage_events` tables, and 6 supporting indexes. Uses `@allow-duplicate-columns` directive.

- **`packages/daemon/src/db/migrate.test.ts`** — Added `runMigrations — memory-learning-schema (migration 105)` describe block with 5 tests proving legacy row survival, new table columns, indexes, and cascade deletion.

## Deviations

None. Followed the design spec contracts exactly.

## Key things downstream pods must know

1. **DB table is `memory_entries`, not `memories`** — SQLite table name established in migration 036.

2. **Migration uses `@allow-duplicate-columns`** — Required because we're using `ALTER TABLE ADD COLUMN` statements. The runner splits on `;`, so **never put a semicolon inside a comment** in this migration file.

3. **`MemoryEntry.tags` and `.sourceEvidence` are TS arrays but SQL JSON strings** — The DB stores `'[]'` as the default. Repositories (brief 02) must JSON-parse/serialize these fields.

4. **`MemoryCandidate.scope` is narrowed to `'profile'`** — The TypeScript type enforces `scope: 'profile'` (literal, not the `MemoryScope` union). The SQL allows any TEXT to keep the constraint relaxed for the future.

5. **Pre-existing build failures** — `@autopod/escalation-mcp` DTS build fails (`timestamp` field missing from `EscalationResponse`). This is pre-existing and unrelated to brief 01 changes. It cascades to `@autopod/daemon` DTS, but runtime tests pass.

6. **Pre-existing test failures** — `profile-store.test.ts` (2 tests) and `quality-score-repository.test.ts` (8 tests) fail on the base branch. My changes did not introduce or fix these.

## Files this brief owns — do not modify without good reason

- `packages/daemon/src/db/migrations/105_memory_learning.sql` — migration files are immutable once deployed
- `packages/shared/src/types/memory.ts` — all new types are defined here; if you add fields, extend rather than rename

## Landmines

- The migration runner in `packages/daemon/src/db/migrate.ts` splits SQL on `;` naively when `@allow-duplicate-columns` is set. Any semicolon in a comment inside an `@allow-duplicate-columns` migration will cause a parse error.
- `memory_usage_events` has `ON DELETE CASCADE` referencing `memory_entries`. Foreign keys must be enabled (`PRAGMA foreign_keys = ON`) at the connection level, which `createTestDb()` already does.
