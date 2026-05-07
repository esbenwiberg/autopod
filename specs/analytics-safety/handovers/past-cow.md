# Handover — past-cow (Brief 02: SafetyEventsRepository + Action/Proxy Writers)

## What was built

Five areas implemented:

### 1. `collectPiiPatternNames(text)` helper — `packages/shared/src/sanitize/collect-pii.ts`
Iterates `PII_PATTERNS` and returns the names of all patterns that match at least once.
Resets `lastIndex = 0` on each shared (global-flagged) regex before calling `.test()`.
Exported from `packages/shared/src/sanitize/index.ts` and `packages/shared/src/index.ts`.

### 2. `SafetyEventsRepository` — `packages/daemon/src/safety/safety-events-repository.ts`
Full implementation of the interface from the design spec:
- `insert(entry)` — returns `number` (rowid, required for `attachPodId`)
- `attachPodId(rowIds, podId)` — backfill pattern for issue-watcher (Brief 04)
- `countByKindInWindow`, `countByPatternInWindow`, `countBySourceInWindow` — GROUP BY queries
- `countByPodInWindow(days, limit)` — ordered by `lastEventAt DESC`; NULL pod_id rows return `podId: null`
- `topInjectionsForPod(podId, limit)` — uses SQLite `IS ?` operator to handle null/non-null in one query
- `sparkline(days)` — JS date loop fills all N days including zeros

Coverage in `safety-events-repository.test.ts`: insert+read round-trip, trailing-window cutoff, attachPodId backfill, countByPatternInWindow grouping, countByPodInWindow ordering, topInjectionsForPod, sparkline (exactly N entries).

### 3. `pii_categories` on audit-repository — `packages/daemon/src/actions/audit-repository.ts`
- `insert()` now accepts `piiCategories: string[] | null` and stores as JSON text
- `rowToAuditEntry()` parses JSON back to `string[] | null`
- `computeEntryHash` and `verifyAuditChain` are **untouched** — ADR-019 enforced
- `ActionAuditEntry` interface extended with `piiCategories?: string[] | null`

### 4. action-engine instrumentation — `packages/daemon/src/actions/action-engine.ts`
At the `processContentDeep` call site (success path only):
- Derives `piiCategories` from raw text (only when `sanitized=true`)
- Writes one `safety_events` row per injection threat (`source='action_response'`, `kind='injection'`)
- Writes one `safety_events` row per PII pattern hit (`source='action_response'`, `kind='pii'`, `severity=null`)
- `payloadExcerpt` = first 256 chars of **post-sanitize** `processedData`
- Passes `piiCategories` into `auditRepo.insert()`

### 5. mcp-proxy instrumentation — `packages/daemon/src/api/mcp-proxy-handler.ts`
Same pattern as action-engine, `source='mcp_proxy'`. PII collected from original `responseText` (pre-sanitize, matching action-engine convention). Existing `log.warn('MCP proxy: response quarantined')` unchanged.

### 6. DI wiring
- `packages/daemon/src/index.ts` — constructs `safetyEventsRepo` from the shared `db` handle, passes to `makeActionEngine()` and `createServer()`
- `packages/daemon/src/api/server.ts` — `safetyEventsRepo?` added to `ServerDependencies`, forwarded to `mcpProxyHandler`

## Deviations from brief

One minor deviation:
- **`insert()` return type**: The design spec interface showed `void`. Changed to `number` (returns rowid) because `attachPodId(rowIds, podId)` requires callers to hold rowids from prior inserts. Without returning the rowid, the issue-watcher pattern (Brief 04) cannot work. Brief 04 depends on this; the interface in `safety-events-repository.ts` is the source of truth.

## Files owned — do not modify without good reason

- `packages/daemon/src/safety/safety-events-repository.ts` — core interface + implementation
- `packages/shared/src/sanitize/collect-pii.ts` — PII pattern name helper

## Contract notes for downstream pods

### For Brief 03 (section-resolver, skill-resolver, pod-manager):
- `SafetyEventsRepository` is available via DI — Brief 03 receives it the same way Brief 02 does (passed through `createServer` → handlers). The `insert()` signature is stable.
- `safetyEventsRepo` is optional (`?`) on all boundaries — safe to skip for handler code that doesn't write events.

### For Brief 04 (issue-watcher, POST /pods):
- `attachPodId(rowIds: number[], podId: string)` — call after `podManager.createSession` returns. Collect rowids from `insert()` before the pod exists, then backfill.
- POST /pods pre-creation rows use `podId: null` permanently — they aggregate under `__pre_creation__` in Brief 05's aggregator. Do not try to backfill these.

### For Brief 05 (analytics endpoint):
- `countByPodInWindow` returns `podId: null` for NULL pod_id rows. Brief 05 maps these to `'__pre_creation__'` in the aggregator — the repo does NOT do this mapping.
- `sparkline(days)` always returns exactly `days` entries. Zero-count days included.
- `topInjectionsForPod(null, limit)` returns injection rows where `pod_id IS NULL`.

### Hash chain (ADR-019):
- `pii_categories` is in `action_audit` but NOT in `computeEntryHash`. Any Brief that touches `audit-repository.ts` must NOT add `piiCategories` to the hash payload.
