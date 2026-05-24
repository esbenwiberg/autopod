# Handover: pleased-bee — Brief 02 (Memory Repositories)

## What was built

### `packages/daemon/src/pods/memory-repository.ts` (updated)

- **Extended `rowToMemoryEntry`** to parse `kind`, `tags` (JSON), `appliesWhen`, `avoidWhen`, `confidence`, `sourceEvidence` (JSON), `impactSummary` from the new columns added in migration 105. Legacy rows (NULL columns) return `null`/`[]` defaults.
- **Extended `insert`** to write all new metadata fields.
- **Added `updateMetadata(id, content, metadata)`** — updates content + all seven metadata fields and increments `version`. Used by `MemoryCandidateRepository.approve` for update candidates.
- **Exported `parseJsonColumn<T>`** — shared JSON-parse-with-fallback utility imported by the candidate repository.
- **Fixed `insert`** to return the constructed entry directly (no post-insert re-read SELECT).

### `packages/daemon/src/pods/memory-candidate-repository.ts` (new)

- `MemoryCandidateRepository` interface with `insert`, `get`, `listPending`, `list`, `approve`, `reject`.
- **`approve('create')`** — calls `memoryRepo.insert` to create a new approved `profile`-scoped memory entry (with `createdByPodId: null` since it's the human reviewer creating it; the candidate retains the originating pod ID for provenance). Marks candidate `approved`. Returns updated candidate without re-reading.
- **`approve('update')`** — calls `memoryRepo.updateMetadata` on the target memory, incrementing its `version`. No duplicate memory entry is created. Returns updated candidate without re-reading.
- **`reject`** — marks candidate `rejected` and retains the row for audit history. Returns updated candidate without re-reading.
- Uses `generateId(8)` (from `@autopod/shared`) for new memory IDs, consistent with existing memory route.
- **Does NOT auto-approve** — all candidates start as `pending`.

### `packages/daemon/src/pods/memory-usage-repository.ts` (new)

- `MemoryUsageRepository` interface with `record`, `listByMemory`, `listByPod`.
- Covers all seven `MemoryUsageKind` values: `selected`, `injected`, `read`, `searched`, `plan_reported`, `summary_reported`, `not_reported`.
- `ON DELETE CASCADE` from `memory_usage_events` to `memory_entries` is honored — tested.

### `packages/daemon/src/pods/memory-repository.test.ts` (new)

22 tests covering:
- Legacy-row mapping (NULL columns → safe defaults)
- Metadata persistence (all seven new fields round-trip)
- `updateMetadata` version increment
- `update` version increment without touching metadata
- `list` approved-only filter
- `search` keyword matching
- Candidate insert/get
- `listPending` scoping
- Candidate `approve` ('create' action) — new memory created, no duplicate
- Candidate `approve` ('update' action) — version incremented, no new entry
- Candidate `reject` — retained for audit, no memory entry created
- Candidate `list` with status filter
- Usage event record, `listByMemory`, `listByPod`
- CASCADE deletion of usage events when memory is deleted

### `packages/daemon/src/pods/index.ts` (updated)

Exports `createMemoryCandidateRepository`, `MemoryCandidateRepository`, `createMemoryUsageRepository`, `MemoryUsageRepository`.

## Deviations

- **`daemon/src/index.ts` not wired** — Brief said to wire both repos in `src/index.ts`. Not done because there are no consumers yet (API routes come in brief 06) and `noUnusedLocals: true` would cause a build failure. The export from `pods/index.ts` is sufficient; brief 06 should add instantiation when routes are added.

## Key things downstream pods must know

1. **`parseJsonColumn<T>` is exported from `memory-repository.ts`** — import it there if you need it in another repository in the `pods/` directory.

2. **`memory_entries.created_by_pod_id` is a FK to `pods(id)`** — must be `null` or a real pod ID. In `approve('create')`, the new memory entry gets `createdByPodId: null`; the candidate retains `createdByPodId` for provenance.

3. **`approve` takes both `id` and `memoryRepo`** — this is intentional. The approval is designed as an atomic operation (status flip + memory create/update together). Brief 06 routes will need to pass both repos.

4. **`MemoryUsageRepository.record` requires the `memoryId` to exist in `memory_entries`** — FK `ON DELETE CASCADE`. Record events only after the memory entry exists.

5. **`memory_candidates.created_by_pod_id` has no FK constraint** — any non-null string is valid. Only `memory_entries.created_by_pod_id` is FK-constrained.

6. **ID generation** — `generateId(8)` from `@autopod/shared` is used for memory entries created via candidate approval (consistent with the existing memory route). Candidate IDs come from the caller.

## Files this brief owns — do not modify without good reason

- `packages/daemon/src/pods/memory-repository.ts` — `parseJsonColumn` is exported; don't rename it without updating the candidate repo import
- `packages/daemon/src/pods/memory-candidate-repository.ts` — new candidate lifecycle logic
- `packages/daemon/src/pods/memory-usage-repository.ts` — new usage event tracking
- `packages/daemon/src/pods/memory-repository.test.ts` — comprehensive test suite for all three repos

## Landmines

- The `approve` method makes two database writes in sequence (one to `memoryRepo`, one to `memory_candidates`). If the first write succeeds but the second fails (crash), the candidate stays `pending` while the memory entry already exists. SQLite transactions can prevent this — brief 06 may want to wrap in `db.transaction()` if atomic consistency is required.
- `listPending` does NOT filter by `scope` (only `scope_id`) — the existing schema only supports `profile` scope for candidates, but if the scope column is extended, `listPending` may need a `scope` filter.
