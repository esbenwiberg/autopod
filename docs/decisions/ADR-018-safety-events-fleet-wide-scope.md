# ADR-018: `safety_events` covers fleet-wide detection, not just issue-watcher

## Status
Accepted

## Context

Phase 4 of the analytics dashboard plan
(`docs/analytics-dashboard-plan.md`) seeded a Safety drill backed by a
single new table called `safety_events`, framed in the seed text as
the persistence target for issue-watcher's PII / injection
detections. The seed implicitly assumed a one-source story: the daemon
already persists action-engine detections via
`action_audit.pii_detected` (boolean) and `quarantine_score`, so a
parallel "issue body" surface seemed sufficient.

A scan of the runtime widened that picture. There are seven distinct
boundaries in the daemon where `processContent` /
`processContentDeep` runs against untrusted text:

1. **action-engine** (`actions/action-engine.ts:182`) — persists
   `pii_detected` + `quarantine_score` to `action_audit`. Only this
   site has any durable record of detections today.
2. **mcp-proxy-handler** (`api/mcp-proxy-handler.ts:91`) — logs
   threats; does not persist.
3. **issue-watcher** (`issue-watcher/issue-watcher-service.ts:137`) —
   logs threats; does not persist.
4. **section-resolver** (`pods/section-resolver.ts:74`) — logs
   threats; does not persist.
5. **skill-resolver** (`pods/skill-resolver.ts:62`) — silent. Result
   of `processContent` is discarded after the sanitized text is used.
6. **POST /pods free-text** (`api/routes/pods.ts:115`) — silent.
   Sanitizes `body.task` / `body.seriesName` /
   `body.seriesDescription` but logs nothing.
7. **event-bus content sanitization**
   (`pods/event-bus.ts contentProcessing` branch) — wired but **dead
   code in production**: `createEventBus(...)` at `index.ts:176` does
   not pass the `contentProcessing` option, so the branch never
   runs.

The operator's stated success signal is "guardrails fired N times
this month, here's exactly which patterns and on which pods, audit
chain verified." A single-source `safety_events` table backed only by
issue-watcher would let the dashboard say "issue-body detections fired
N times" — which is not what the drill claims to show. Five out of
seven sites fire silently today; without a fleet-wide capture the
Safety story is misleading.

Two design alternatives were considered:

- **Option A (seed-as-written): `safety_events` scoped to issue-watcher
  only.** Other sites stay log-only. Pros: minimal blast radius.
  Cons: drill claims "guardrails working" while five of seven sources
  go uncounted. Operator gets a misleading number.
- **Option B (this ADR): `safety_events` scoped to all six active
  detection sites with a `source` enum.** Each writer adds one
  insert per pattern hit. Pros: drill counts every fire; pattern
  breakdown is accurate; per-site filtering is possible later. Cons:
  six writer-site edits instead of one; a new repository surface;
  per-pattern row granularity changes the storage shape from
  "one summary per detection event" to "one row per pattern hit."

## Decision

Adopt Option B. `safety_events` is fleet-wide.

Schema includes:

- `source` — enum `'action_response' | 'mcp_proxy' | 'issue_body' |
  'claude_md_section' | 'skill_content' | 'pod_input' |
  'event_payload'`. The `event_payload` value is reserved for the
  day `event-bus.ts` content processing is wired in production
  (today the branch is dead code). All other values map to active
  writer sites that this phase instruments.
- `kind` — `'pii' | 'injection'`. Mirrors the two-step
  `processContent` pipeline (quarantine → sanitize).
- `pattern_name` — one row per pattern hit. A single
  `processContent` call that detects two patterns writes two rows.
  Multi-pattern detections fan out instead of summarising. This
  yields clean GROUP BY semantics for the pattern breakdown without
  client-side parsing.
- `severity` — REAL NULL. Populated for `kind='injection'` rows
  from `INJECTION_PATTERNS[].severity`; NULL for `kind='pii'`.
- `pod_id` — TEXT NULL. NULL for pre-creation detections
  (issue-watcher and POST /pods free-text fire before the pod
  exists). Issue-watcher backfills via a follow-up update once
  `createSession` returns; POST /pods rows stay NULL forever and
  aggregate under `__pre_creation__` in the response.
- `payload_excerpt` — TEXT NULL, 256 chars max, *post-sanitize*. The
  redacted/quarantined text is safe to persist; the raw input is
  never stored.

The `action_audit.pii_detected` boolean stays — it's load-bearing for
the existing behaviour and the chain hash (it's not in the hash
payload but the column itself is part of the row schema). The new
`pii_categories` column on `action_audit` (ADR-019) carries the
pattern-name array for the action-engine path, in parallel with
`safety_events` rows for the same detection. Brief 05's aggregator
treats `safety_events` as the canonical source for forward rows; the
`action_audit pii_detected=1 AND pii_categories=NULL` legacy bucket
fills in pre-Phase-4 history under pattern name `unknown`.

`safety_events` is **forward-only** — there is no backfill of
historical detections. The drill window ramps up over the trailing
30 days; older queries show progressively less data until the table
is fully populated.

## Consequences

**Easier:**
- The drill's stated success signal — "guardrails fired N times
  across all sources" — is actually computable from one query.
- Per-source filtering is a one-liner change to the aggregator if
  the operator ever wants it.
- Adding a seventh source (e.g. enabling `event_payload`) is a
  one-writer-site change with no schema migration.
- Pattern breakdowns are accurate without client-side parsing.

**Harder:**
- Six writer-site edits in this phase (Briefs 02, 03, 04). Each
  needs to thread `safetyEventsRepo` via DI. Counterbalanced by the
  uniform interface — every site calls `insert(...)` per pattern.
- Two of the six sites are pre-creation (`issue-watcher`,
  `pod_input`); they need a backfill path or the
  `__pre_creation__` bucket. Issue-watcher gets `attachPodId(...)`
  for backfill; POST /pods stays NULL permanently (acceptable
  trade-off — no clean post-creation hook in that route).
- One row per pattern means storage scales with pattern density. A
  detection event with five patterns writes five rows. For an
  operator-grade fleet (single-user, ~100s of pods/month), the
  volume is negligible. Documented for the day this is wrong.

**Committed to:**
- The `source` enum is a contract — adding values is fine, renaming
  or removing is not. Changes ripple through the aggregator, the
  Swift Codable mirror, and the drill's `bySource` chart bucketing.
- One-row-per-pattern granularity is a contract for the aggregator's
  GROUP BY assumptions. Switching to one-row-per-event later would
  require a follow-up migration and aggregator rewrite.
- `payload_excerpt` is post-sanitize. Storing pre-sanitize raw text
  would re-introduce the leakage the sanitizer prevents — explicitly
  out of scope.
