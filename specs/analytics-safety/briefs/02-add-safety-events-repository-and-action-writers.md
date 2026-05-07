---
title: "Add safety_events repository + action-engine + mcp-proxy writers"
depends_on: [01-add-safety-migrations-and-types]
acceptance_criteria:
  - { type: cmd, test: "test -f packages/daemon/src/safety/safety-events-repository.ts", pass: "exit 0", fail: "missing repository module" }
  - { type: cmd, test: "rg -l 'pii_categories' packages/daemon/src/actions/audit-repository.ts", pass: "≥1 match", fail: "audit-repository did not learn the new column" }
  - { type: cmd, test: "rg -l 'safety_events|safetyEventsRepo' packages/daemon/src/actions/action-engine.ts packages/daemon/src/api/mcp-proxy-handler.ts", pass: "≥2 matches (one per file)", fail: "action-engine or mcp-proxy did not adopt the writer" }
touches:
  - packages/daemon/src/safety/safety-events-repository.ts
  - packages/daemon/src/safety/safety-events-repository.test.ts
  - packages/daemon/src/actions/audit-repository.ts
  - packages/daemon/src/actions/audit-repository.test.ts
  - packages/daemon/src/actions/action-engine.ts
  - packages/daemon/src/actions/action-engine.test.ts
  - packages/daemon/src/api/mcp-proxy-handler.ts
  - packages/daemon/src/api/mcp-proxy-handler.test.ts
  - packages/daemon/src/index.ts
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/pods/section-resolver.ts
  - packages/daemon/src/pods/skill-resolver.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/issue-watcher/
  - packages/daemon/src/api/routes/pods.ts
  - packages/desktop/
---

## Task

Build the writer half of the Safety pipeline for the action paths:

1. **`SafetyEventsRepository`** — a new repository in
   `packages/daemon/src/safety/` implementing the interface defined in
   `design.md` → "Helper signature". `insert`, `attachPodId`, plus the
   read methods Brief 05's aggregator needs (`countByKindInWindow`,
   `countByPatternInWindow`, `countBySourceInWindow`,
   `countByPodInWindow`, `topInjectionsForPod`, `sparkline`). Trailing
   window expressed via the same SQLite cutoff pattern Phases 1–3 use:
   `datetime('now', '-' || ? || ' days')`.

2. **`pii_categories` write** — extend
   `packages/daemon/src/actions/audit-repository.ts` `insert(entry)` to
   accept and persist `piiCategories: string[] | null`. Stored as JSON
   text. **Critical: do NOT include `piiCategories` in
   `computeEntryHash` (ADR-019).** The hash payload is locked at
   `prev_hash || pod_id || action_name || params || response_summary
   || quarantine_score || created_at`. Adding `pii_categories` to that
   list would silently invalidate every existing chain. Add a
   targeted unit test that proves the hash for an entry is identical
   regardless of `piiCategories` value.

3. **action-engine instrumentation** — at the existing
   `processContentDeep` call (`action-engine.ts:182-208`), derive PII
   pattern names from the raw input via a new helper (suggest:
   `collectPiiPatternNames(text)` co-located in
   `packages/shared/src/sanitize/`). Pass the resulting array into
   `auditRepo.insert(...)` as `piiCategories`. When `threats.length >
   0`, also write `safety_events` rows — one per threat — with
   `source='action_response'`, `kind='injection'`,
   `severity=threat.severity`, `payloadExcerpt=<first 256 chars of
   sanitized text>`. PII-only detections (sanitized=true, threats=[])
   write `kind='pii'` rows, one per pattern hit, with `severity=NULL`.

4. **mcp-proxy instrumentation** — at the existing `processContent`
   call (`mcp-proxy-handler.ts:91-105`), if threats fire OR PII
   patterns fire, write per-pattern `safety_events` rows with
   `source='mcp_proxy'`. Keep the existing log line. Same payload
   excerpt rule as action-engine.

5. **DI wiring** — `packages/daemon/src/index.ts` constructs the new
   repo from the shared SQLite handle and threads it into the
   `ActionEngine` and the MCP proxy handler.

## Touches

- `packages/daemon/src/safety/safety-events-repository.ts` (new) — SQL
  + tests' surface. Implement against the `safety_events` schema from
  Brief 01.
- `packages/daemon/src/safety/safety-events-repository.test.ts` (new)
  — coverage against `createTestDb()`.
- `packages/daemon/src/actions/audit-repository.ts` — extend `insert`,
  extend `rowToEntry`, leave `computeEntryHash` and `verifyAuditChain`
  untouched.
- `packages/daemon/src/actions/audit-repository.test.ts` — add
  hash-stability test + round-trip test for `pii_categories`.
- `packages/daemon/src/actions/action-engine.ts` — derive
  `piiCategories`, write `safety_events`, pass categories into the
  audit insert. Single call site already exists; do not refactor the
  surrounding code.
- `packages/daemon/src/actions/action-engine.test.ts` — extend with:
  PII-only path, injection path, mixed path, hash-stability proof.
- `packages/daemon/src/api/mcp-proxy-handler.ts` — write
  `safety_events` rows; keep behaviour otherwise unchanged.
- `packages/daemon/src/api/mcp-proxy-handler.test.ts` — extend.
- `packages/daemon/src/index.ts` — DI wiring only.
- `packages/shared/src/sanitize/` (additive) — small
  `collectPiiPatternNames(text)` helper if one isn't already in
  `processor.ts`. Reuse `PII_PATTERNS[].name` directly. (Out of touch
  list because it's additive — don't rewrite `processor.ts`.)

## Does not touch

- `packages/daemon/src/db/migrations/` — Brief 01 owns. No schema
  edits.
- `packages/daemon/src/pods/section-resolver.ts` /
  `skill-resolver.ts` / `pod-manager.ts` — Brief 03 instruments these.
- `packages/daemon/src/issue-watcher/` — Brief 04.
- `packages/daemon/src/api/routes/pods.ts` — Brief 05 (analytics
  endpoint) and Brief 04 (POST /pods sanitization writer).
- `packages/desktop/` — Brief 06.

## Constraints

- **Hash payload immutability** (ADR-019). The `pii_categories` field
  rides alongside the row but is invisible to the chain. Any future
  reader that wants to reconstruct the canonical hash payload must get
  the identical bytes whether `piiCategories` is `NULL`, `[]`, or
  `["api-key","email"]`. The hash-stability test gates this.
- **One row per pattern hit** in `safety_events`. A single
  `processContent` call that detects `api-key` AND `email` writes two
  rows. The aggregator depends on this for clean GROUP BY semantics.
- **`payload_excerpt` is post-sanitize** — first 256 chars of the
  text *after* the sanitize/quarantine pipeline ran. The raw input
  may contain the redacted PII; store the sanitized version. `null` is
  acceptable when the source has no readable text context (rare; not
  expected on these two paths).
- **Severity**: `INJECTION_PATTERNS[].severity` (0..1) for
  `kind='injection'` rows; `NULL` for `kind='pii'` rows. PII patterns
  carry no severity field — do not invent one.
- **No `event_payload` writes**: the enum value exists but Brief 02
  never writes that source. Documented in `purpose.md` → Non-goals.
- **Never call `pod.status = x`** or any other state-machine bypass.
  This brief inserts into a forward-only log; it does not transition
  pods. (Mentioned because `action-engine.ts` is in the orchestration
  blast radius and the temptation to refactor exists.)
- **Backwards compatibility on action_audit**: pre-Brief-02 rows have
  `pii_categories=NULL`. New aggregations must treat NULL on a row
  with `pii_detected=1` as bucket `unknown` — but that bucketing
  happens in Brief 05's aggregator, not here.

## Test expectations

### `SafetyEventsRepository`
- **insert + read round-trip**: insert one PII row + one injection
  row, confirm both come back via the appropriate count methods.
- **trailing-window cutoff**: insert rows at `now - 5 days` and
  `now - 35 days`; `countByKindInWindow(30)` returns the recent one
  only.
- **`attachPodId`**: insert a row with `pod_id=NULL`, call
  `attachPodId([rowId], 'abc12345')`, then read back and confirm
  attribution. (Used by Brief 04's issue-watcher; tested here.)
- **`countByPatternInWindow`**: seed three injections matching two
  patterns; result groups correctly.
- **`countByPodInWindow` ordering**: ordered by `lastEventAt DESC`,
  truncated by `limit`, NULL pod_id rows aggregated under a
  synthetic key — confirm the repo's chosen sentinel matches what
  Brief 05's aggregator expects.
- **`sparkline(days)`**: returns exactly `days` entries, including
  zero days.

### `audit-repository`
- **Round-trip `pii_categories`**: insert with `["api-key","email"]`,
  read back `["api-key","email"]`. Insert with `null`, read back
  `null`.
- **Hash stability**: build two entries identical except for
  `piiCategories` (`null` vs `["api-key"]`). Their `entry_hash` must
  be byte-identical. This is the ADR-019 gate.
- **Existing `verifyAuditChain` test stays green**: don't modify the
  test to accommodate the new column; the chain math is unchanged.

### `action-engine`
- **PII only** — `processContentDeep` returns `sanitized=true,
  threats=[]`, two PII patterns matched. Verify: one `action_audit`
  row with `pii_categories=["..","..."]`, two `safety_events` rows
  with `kind='pii', severity=NULL, source='action_response'`.
- **Injection only** — threats=[two patterns], no PII. Two
  `safety_events` rows with `kind='injection', severity=<value>`.
- **Both** — combined behaviour: audit row with `pii_categories`
  populated AND multiple `safety_events` rows split by `kind`.
- **Quarantine score still set** — confirm
  `auditRepo.insert.quarantineScore` continues to receive the
  `quarantine_score` from `processContentDeep` (not affected by the
  PII work but worth a sanity check given we touched this site).

### `mcp-proxy-handler`
- **Threat path** — single threat write produces one
  `safety_events` row with `source='mcp_proxy', kind='injection'`.
- **PII path** — ensure it writes `kind='pii'` rows (this site's
  `processContent` returns sanitized output too).
- **Existing log line** — assert the existing
  `logger.warn('PII / injection detected …')` call still fires.

## Risks / pitfalls

- **Accidentally hashing `pii_categories`.** Re-read
  `computeEntryHash` after editing `insert`. Adding a positional arg
  in the middle is the failure mode. The hash-stability test catches
  this in unit tests; CI will catch a subtler regression on existing
  databases at startup.
- **`payload_excerpt` size**: 256 chars *after* sanitization. The
  sanitizer's redaction tokens (e.g. `[REDACTED:api-key]`) must be
  preserved as-is — don't double-redact. Post-sanitize text is
  already safe to persist.
- **Counting rows when patterns repeat**: `processContentDeep` may
  return the same pattern twice (e.g. two API keys in one blob). One
  row per match is correct; do not de-dupe.
- **DI wiring**: `index.ts` already passes a SQLite handle to repos
  on construction — follow the existing pattern. Don't introduce a
  new factory abstraction.
- **PII helper location**: if `processor.ts` already exposes a way to
  enumerate matched pattern names, reuse it. Don't double-implement.
  If you add `collectPiiPatternNames`, place it next to
  `processContent` and export from `packages/shared/src/index.ts`.
- **Testing approach**: use `createTestDb()` for
  `safety-events-repository.test.ts` — wires real SQLite in-memory.
  For `action-engine.test.ts`, the existing test harness mocks the
  audit repo; extend it minimally rather than rewriting.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run `./scripts/validate.sh`; build + lint + tests must pass.
3. Commit and push.
