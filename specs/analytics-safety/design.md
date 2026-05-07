# Design — Analytics Safety / Guardrails

## Blast radius

### Database (Brief 01)
- `packages/daemon/src/db/migrations/092_safety_events.sql` (new) — creates the
  `safety_events` table + indexes. Highest existing prefix is `091`; never reuse.
- `packages/daemon/src/db/migrations/093_action_audit_pii_categories.sql` (new) —
  `ALTER TABLE action_audit ADD COLUMN pii_categories TEXT DEFAULT NULL`. Outside
  the hash payload by design (ADR-019).
- `packages/daemon/src/db/migrations/094_pods_network_policy_resolved.sql` (new) —
  `ALTER TABLE pods ADD COLUMN network_policy_resolved TEXT DEFAULT NULL`.
- `packages/daemon/src/db/migrations/095_audit_chain_verifications.sql` (new) —
  small append-only log of fleet-wide chain verifications.

### Shared types (Brief 01)
- `packages/shared/src/types/analytics.ts` — add `SafetyAnalyticsResponse` and the
  `SafetyEventKind` / `SafetyEventSource` / `AuditChainVerifyResponse` /
  `NetworkPolicyDistribution` helper types.
- `packages/shared/src/index.ts` — re-export the new types.

### Daemon — repository + writers (Briefs 02, 03, 04)
- `packages/daemon/src/safety/safety-events-repository.ts` (new, Brief 02) —
  `insert`, `listInWindow(days)`, `summarize(days)`, `countByPattern(days)`,
  `countByPod(days)`, `countBySource(days)`. Trailing-window-aware.
- `packages/daemon/src/safety/safety-events-repository.test.ts` (new, Brief 02).
- `packages/daemon/src/index.ts` (Brief 02) — wire the new repo + the
  audit-chain-verifications repo (added in Brief 05).
- `packages/daemon/src/actions/audit-repository.ts` (Brief 02) — extend
  `insert(entry)` to accept and persist `pii_categories: string[] | null`.
  **Do not include `pii_categories` in `computeEntryHash`** (ADR-019).
- `packages/daemon/src/actions/audit-repository.test.ts` (Brief 02) — extend.
- `packages/daemon/src/actions/action-engine.ts` (Brief 02) — at the existing
  `processContentDeep` call site (line ~187), derive
  `piiCategories = sanitized ? collectPiiPatternsFromText(rawData) : null` and pass
  to `auditRepo.insert(...)`. If `threats.length > 0`, also call
  `safetyEventsRepo.insert(...)` once per threat with `source='action_response'`,
  `kind='injection'`. PII-only detections (sanitized=true, threats=[]) write
  `safety_events` rows with `kind='pii'`, `pattern_name=<each PII pattern hit>`,
  `severity=NULL`, deriving the pattern list at the same site.
- `packages/daemon/src/actions/action-engine.test.ts` (Brief 02) — extend.
- `packages/daemon/src/api/mcp-proxy-handler.ts` (Brief 02) — at the existing
  `processContent` call (line ~98), if `result.threats.length > 0` write per-threat
  `safety_events` rows with `source='mcp_proxy'`, `kind='injection'`. PII-only
  detections write `kind='pii'` rows. Keep the existing log line.
- `packages/daemon/src/api/mcp-proxy-handler.test.ts` (Brief 02) — extend.
- `packages/daemon/src/pods/section-resolver.ts` (Brief 03) — at the existing
  `processContent` call (line ~75), instrument analogously.
  `source='claude_md_section'`.
- `packages/daemon/src/pods/section-resolver.test.ts` (Brief 03) — extend.
- `packages/daemon/src/pods/skill-resolver.ts` (Brief 03) — `sanitizeSkillContent`
  currently swallows the `processContent` result. Capture the threats and write
  per-pattern `safety_events` rows with `source='skill_content'`. Keep the
  `pod_id` association — both call sites (line ~118, ~174) have the pod context
  via the parent factory. If pod_id is unavailable in scope, plumb it.
- `packages/daemon/src/pods/skill-resolver.test.ts` (Brief 03) — extend.
- `packages/daemon/src/pods/pod-manager.ts` (Brief 03) — at provisioning, after
  inheritance resolution and just before container spawn, write the resolved
  network policy to the new column via the existing pod-update path. One-line
  change to the existing provisioning block.
- `packages/daemon/src/pods/pod-manager.test.ts` (Brief 03) — extend the
  provisioning test to assert `network_policy_resolved` is written.
- `packages/daemon/src/issue-watcher/issue-watcher-service.ts` (Brief 04) — at the
  existing threat-detection block (lines ~152–166), add per-pattern
  `safety_events` rows with `source='issue_body'`. **`pod_id` is initially NULL**
  because the pod hasn't been created yet at detection time; backfill the pod_id
  via a follow-up update once `podManager.createSession` returns the pod.
- `packages/daemon/src/issue-watcher/issue-watcher-service.test.ts` (Brief 04) —
  extend.
- `packages/daemon/src/api/routes/pods.ts` (Brief 04) — at the POST /pods
  free-text sanitization site (lines ~115–127), if any of `body.task`,
  `body.seriesName`, `body.seriesDescription` produce threats, write
  `safety_events` rows with `source='pod_input'` and `pod_id=NULL` (the request
  hasn't allocated a pod yet — leave NULL). Keep behaviour otherwise unchanged.
- `packages/daemon/src/api/routes/pods.test.ts` (Brief 04) — extend.

### Daemon — analytics endpoints (Brief 05)
- `packages/daemon/src/safety/safety-aggregator.ts` (new) — pure function from raw
  query rows (terminal cohort) to `SafetyAnalyticsResponse`. Co-located test file.
- `packages/daemon/src/safety/safety-aggregator.test.ts` (new).
- `packages/daemon/src/actions/audit-chain-verifier.ts` (new) — fleet-wide walker;
  loops distinct `pod_id` from `action_audit`, calls existing
  `auditRepo.verifyAuditChain(podId)` for each, aggregates result.
- `packages/daemon/src/actions/audit-chain-verifier.test.ts` (new).
- `packages/daemon/src/actions/audit-chain-verifications-repository.ts` (new) —
  `record(result)` and `latest()` against the `audit_chain_verifications` table.
- `packages/daemon/src/api/routes/pods.ts` (modify) — register
  `GET /pods/analytics/safety?days=N` and `POST /audit-chain/verify`. Validation
  envelope mirrors the Reliability/Quality routes (`pods.ts:252-262`).
- `packages/daemon/src/api/routes/pods.test.ts` (modify) — route-level integration
  tests modelled on the Reliability block at `pods.test.ts:119+`.
- `packages/daemon/src/index.ts` (modify) — wire the new aggregator + repo.

### Desktop (Brief 06)
- `packages/desktop/Sources/AutopodClient/Types/SafetyAnalyticsResponse.swift`
  (new) — Codable mirror of the TS contract.
- `packages/desktop/Tests/AutopodClientTests/SafetyAnalyticsResponseTests.swift`
  (new) — JSON decode coverage modelled on
  `ReliabilityAnalyticsResponseTests.swift`.
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` (modify) — add
  `getSafetyAnalytics(days:)` next to `getReliabilityAnalytics`/`getQualityAnalytics`,
  plus `verifyAuditChain()` (POST helper).
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift` (modify) —
  extend the enum with `.safety`. Existing exhaustive switches will fail to
  compile until they handle the new case — do that in the same brief.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`
  (modify) — add `.safety` switch case routing to the new drill view.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` (modify) —
  Safety card data wiring (value = `summary.totalEvents`, sparkline =
  `summary.sparkline.map(\.count)`, delta = `summary.deltaVsPrior`, sub-line =
  `"\(piiCount) PII · \(quarantineCount) quar · \(injectionCount) inj"`).
- `packages/desktop/Sources/AutopodUI/Views/Analytics/SafetyDrillView.swift` (new) —
  five-section drill with days picker; structure mirrors `QualityDrillView` and
  `ReliabilityDrillView`.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` (modify) — pass
  `loadSafetyAnalytics` and `verifyAuditChain` closures into the existing
  `AnalyticsView(...)` call site.

## Seams

Six briefs, four pod boundaries.

1. **Migrations + types (Brief 01).** Owns the durable contracts: schema for
   `safety_events`, `audit_chain_verifications`, the two new columns, and
   `SafetyAnalyticsResponse`. Foundation; everything else depends on it.
2. **Action-related writers (Brief 02).** Owns `SafetyEventsRepository`, the
   `pii_categories` write into `action_audit`, and the action-engine + mcp-proxy
   instrumentation. Also wires the repo into the daemon. Independent of Briefs
   03 and 04 (no shared files).
3. **Pod-bootstrap writers (Brief 03).** Section-resolver, skill-resolver,
   pod-manager (network_policy_resolved at provisioning). Independent of Briefs
   02 and 04.
4. **Ingestion writers (Brief 04).** Issue-watcher and POST /pods free-text.
   Independent of Briefs 02 and 03 — but shares `api/routes/pods.ts` with Brief
   05, so 05 must follow 04.
5. **Analytics endpoint + audit verify endpoint (Brief 05).** Reads from the
   tables/columns Brief 01 created. Returns valid empty-shape response when no
   writers have populated yet — so 05 does NOT depend on 02/03/04 at runtime,
   only on 01 schematically. The ordering constraint vs Brief 04 is a merge
   conflict on `api/routes/pods.ts`.
6. **Desktop card + drill (Brief 06).** Consumes the contract from Brief 05
   verbatim. Hard dependency.

Brief order:
- 01 ships first (sequential).
- 02, 03, 04 may run in parallel after 01.
- 05 must follow 04 (file overlap).
- 06 must follow 05 (contract dependency).

## Contracts

`SafetyAnalyticsResponse` is the only cross-pod contract on the wire. Brief 01
owns the TS source; Brief 06 mirrors in Swift.

```ts
// packages/shared/src/types/analytics.ts (added in Brief 01)

export type SafetyEventKind = 'pii' | 'injection';

export type SafetyEventSource =
  | 'action_response'
  | 'mcp_proxy'
  | 'issue_body'
  | 'claude_md_section'
  | 'skill_content'
  | 'pod_input'
  | 'event_payload'; // unwired today; reserved for forward use

export type NetworkPolicyBucket = 'allow-all' | 'restricted' | 'deny-all' | 'unknown';

export interface SafetyAnalyticsResponse {
  /** High-level totals over the trailing window. Cohort = terminal:
   *  output_mode != 'workspace' AND status IN ('complete','killed','failed')
   *  AND completed_at IN window. */
  summary: {
    /** Total guardrail-fires in window (PII + injection rows). */
    totalEvents: number;
    /** Per-kind counts. */
    byKind: { pii: number; injection: number };
    /** Quarantine flag count = action_audit rows in window where
     *  quarantine_score > 0. High-risk = quarantine_score >= 0.7. */
    quarantineCount: number;
    quarantineHighRiskCount: number;
    /** Length always equals `days` from the query. */
    sparkline: Array<{ day: string; count: number }>;
    /** Direction: 'up' when current > prior by >0, 'down' when <0,
     *  'flat' otherwise. value = signed difference in event count. */
    deltaVsPrior: { value: number; direction: 'up' | 'down' | 'flat' };
  };

  /** Pattern-level breakdown across both kinds.
   *  PII patterns are sourced from action_audit.pii_categories (forward-only)
   *  AND from safety_events kind='pii' rows. Pre-Phase-4 action_audit rows
   *  with pii_detected=1 AND pii_categories=NULL bucket as 'unknown'.
   *  Injection patterns come exclusively from safety_events kind='injection'. */
  byPattern: Array<{
    kind: SafetyEventKind;
    patternName: string;             // e.g. 'api-key', 'direct-instruction', 'unknown'
    count: number;
  }>;

  /** Per-source breakdown. */
  bySource: Array<{ source: SafetyEventSource; count: number }>;

  /** Quarantine score histogram, 10 buckets [0.0..0.1, 0.1..0.2, ..., 0.9..1.0].
   *  Empty buckets emit count=0. Source: action_audit.quarantine_score. */
  quarantineHistogram: Array<{ bucket: string; count: number }>;

  /** Pods that triggered ≥1 safety_events row in window. Up to 50 entries
   *  ordered by `lastEventAt` DESC. Pods with NULL pod_id (e.g. POST /pods
   *  pre-creation detections, or issue-watcher pre-creation) are aggregated
   *  under a synthetic `__pre_creation__` group. */
  byPod: Array<{
    podId: string | '__pre_creation__';
    profile: string | null;          // null when pod_id is __pre_creation__
    eventCount: number;
    lastEventAt: string;             // ISO
    /** Up to 5 most recent injection rows; payload_excerpt + pattern + severity. */
    topInjections: Array<{
      patternName: string;
      severity: number | null;
      payloadExcerpt: string;        // <= 256 chars, post-sanitize
      createdAt: string;
    }>;
  }>;

  /** Network-policy distribution over the terminal cohort.
   *  Source: pods.network_policy_resolved (snapshotted at provisioning).
   *  Pods with NULL value bucket as 'unknown' (pre-migration pods). */
  networkPolicy: Array<{ bucket: NetworkPolicyBucket; count: number }>;

  /** Latest fleet-wide audit-chain verification result. Null when no
   *  verification has ever been run. */
  auditChain: {
    lastVerifiedAt: string | null;   // ISO
    valid: boolean | null;           // null when never run
    totalPods: number | null;
    totalEntries: number | null;
    firstMismatch: { podId: string; rowId: number; reason: string } | null;
  };
}

export interface AuditChainVerifyResponse {
  /** True when every pod's chain verifies. */
  valid: boolean;
  /** Number of distinct pod_id values walked. */
  totalPods: number;
  /** Total action_audit rows verified. */
  totalEntries: number;
  /** Set when valid=false. */
  firstMismatch: { podId: string; rowId: number; reason: string } | null;
  /** ISO timestamp written into audit_chain_verifications. */
  ranAt: string;
}
```

### Validation rules on the daemon side (mirror Reliability/Quality)
- `days` defaults to `30`.
- `days < 1` → `400 { error: 'days must be a positive integer', code: 'invalid_days' }`.
- `days > 365` → `400` with the same code.
- Terminal-cohort filter applied to every section, including the injection table
  and the network-policy distribution. Reuse the existing
  `buildTerminalCohortClause(days)` helper if Phase 2 already extracted it; else
  inline the predicate identically and note it.

### `safety_events` schema (Brief 01)

```sql
CREATE TABLE IF NOT EXISTS safety_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pod_id          TEXT    NULL,                      -- NULL for pre-creation detections
  source          TEXT    NOT NULL,                  -- enum, see SafetyEventSource
  kind            TEXT    NOT NULL,                  -- 'pii' | 'injection'
  pattern_name    TEXT    NOT NULL,                  -- one row per pattern hit
  severity        REAL    NULL,                      -- 0..1 for injection; NULL for pii
  payload_excerpt TEXT    NULL,                      -- <= 256 chars, post-sanitize text
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);

CREATE INDEX IF NOT EXISTS idx_safety_events_created_at ON safety_events(created_at);
CREATE INDEX IF NOT EXISTS idx_safety_events_kind_created_at ON safety_events(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_safety_events_pod_id ON safety_events(pod_id);
```

### `audit_chain_verifications` schema (Brief 01)

```sql
CREATE TABLE IF NOT EXISTS audit_chain_verifications (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at                   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  total_pods               INTEGER NOT NULL,
  total_entries            INTEGER NOT NULL,
  valid                    INTEGER NOT NULL,        -- 0 | 1
  first_mismatch_pod_id    TEXT    NULL,
  first_mismatch_row_id    INTEGER NULL,
  first_mismatch_reason    TEXT    NULL
);
```

### `action_audit.pii_categories` (Brief 01)

```sql
ALTER TABLE action_audit ADD COLUMN pii_categories TEXT DEFAULT NULL;
-- JSON array of pattern names, e.g. '["api-key","email"]'.
-- Populated forward by Brief 02. Pre-existing rows remain NULL → 'unknown' bucket
-- in the pattern breakdown. NOT included in the audit-chain hash payload (ADR-019).
```

### `pods.network_policy_resolved` (Brief 01)

```sql
ALTER TABLE pods ADD COLUMN network_policy_resolved TEXT DEFAULT NULL;
-- 'allow-all' | 'restricted' | 'deny-all' | NULL
-- Written by pod-manager at provisioning (Brief 03), after profile inheritance.
-- Pre-migration pods bucket as 'unknown' in the drill (ADR-020).
```

### Helper signature (consumed by Briefs 02, 03, 04)

The repository surface every writer brief consumes:

```ts
// packages/daemon/src/safety/safety-events-repository.ts (Brief 02 owns)
export interface SafetyEventInsert {
  podId: string | null;
  source: SafetyEventSource;
  kind: SafetyEventKind;
  patternName: string;
  severity: number | null;       // INJECTION_PATTERNS[].severity for kind='injection'; null for 'pii'
  payloadExcerpt: string | null; // first 256 chars of post-sanitize text; null when source has no text context
}

export interface SafetyEventsRepository {
  insert(entry: SafetyEventInsert): void;
  /** Backfill pod_id once the pod is created (issue-watcher pattern). */
  attachPodId(rowIds: number[], podId: string): void;
  // ...read methods used by Brief 05's aggregator:
  countByKindInWindow(days: number): { pii: number; injection: number };
  countByPatternInWindow(days: number): Array<{ kind: SafetyEventKind; patternName: string; count: number }>;
  countBySourceInWindow(days: number): Array<{ source: SafetyEventSource; count: number }>;
  countByPodInWindow(days: number, limit: number): Array<{ podId: string | null; eventCount: number; lastEventAt: string }>;
  topInjectionsForPod(podId: string | null, limit: number): Array<{ patternName: string; severity: number | null; payloadExcerpt: string | null; createdAt: string }>;
  sparkline(days: number): Array<{ day: string; count: number }>;
}
```

`attachPodId` exists for the issue-watcher case: it captures `safety_events` rows
during sanitization (before `createSession`) and updates them once the pod id is
known, so the byPod section can attribute the event correctly. POST /pods
free-text rows stay `pod_id=NULL` permanently and aggregate under
`__pre_creation__`.

## UX flows

### Sidebar
Single `Analytics` row. Click → middle pane Overview includes the Safety card
alongside Cost / Reliability / Quality / (placeholders for Throughput / Models).

### Overview — Safety card
Same `AnalyticsCard` API as the others (`AnalyticsView.swift:84-96`):
- **value:** `String(summary.totalEvents)` — formatted `"127"`. When 0:
  value = `"0"`.
- **sparkline:** `summary.sparkline.map(\.count)` — combined daily count.
  Empty window → nil sparkline.
- **delta:** `AnalyticsCardDelta` formatted as `±N` events vs prior window.
  Empty cohort: nil.
- **sub-line under value:** `"\(piiCount) PII · \(quarantineCount) quar ·
  \(injectionCount) inj"`. Where `piiCount = summary.byKind.pii`,
  `quarantineCount = summary.quarantineCount`,
  `injectionCount = summary.byKind.injection`. The middle dot is U+00B7.
  Suppressed entirely when `totalEvents == 0` and `quarantineCount == 0`.
- **isSelected / onClick:** unchanged from the existing pattern.

The card pulls from `loadSafetyAnalytics`, threaded through `MainView`.

### Drill view — `SafetyDrillView`
Header (sticky inside the right-pane scroll):
- **Days picker:** numeric stepper or menu; default 30; values `7 / 14 / 30 / 60
  / 90`. Re-fetches `/pods/analytics/safety?days=N`.

Body, in scroll order:

1. **PII histogram by pattern** — horizontal `Charts.BarMark` bar chart, bars
   sorted by `count` DESC. Source: `byPattern.filter { $0.kind == .pii }`.
   `unknown` bucket included when present (legacy rows). Bar value label shows
   the count. Empty state: `"No PII redactions in last N days."`.

2. **Quarantine score histogram** — 10-bucket bar chart over
   `quarantineHistogram`. Bars colored ramp from neutral to red as score rises;
   the 0.7+ buckets carry a `(high risk)` caption. Empty: `"No action quarantine
   data."`.

3. **Injection attempts table** — `Table` with columns `When`, `Source`,
   `Pattern`, `Severity`, `Pod`. Source: derive client-side from the
   `byPod[].topInjections` arrays (most-recent-first across pods). Row click →
   fires `onSelectPod(podId)`; `__pre_creation__` rows are non-clickable. Empty
   state: `"No injection attempts in last N days."`. Sortable by `When` and
   `Severity`.

4. **Audit-chain integrity widget** — single bordered card. Title: `"Audit
   chain"`. Body shows `auditChain` fields:
   - `lastVerifiedAt` rendered as relative time (`"Verified 4m ago"`); `"Never
     verified"` when null.
   - `valid: true` → green checkmark + `"\(totalEntries) entries across
     \(totalPods) pods, 0 mismatches"`.
   - `valid: false` → red X + `"Mismatch on pod \(firstMismatch.podId), row
     \(firstMismatch.rowId)"`.
   - `valid: null` → neutral chip `"No verification on file."`.
   - Trailing `"Verify now"` button → POST `/audit-chain/verify`; loading state
     shown on the button; on success, refresh the safety endpoint to repopulate
     the widget.

5. **Network-policy distribution** — horizontal stacked bar (or 4 small
   counters). Source: `networkPolicy`. Caption beneath: `"of \(totalCohort) pods
   in window"`.

States across all sections:
- **Loading:** `ProgressView` per-section skeleton.
- **Empty:** per-section empty copy as above.
- **Error:** red caption banner above sections — same pattern as
  `ReliabilityDrillView`.

### Row-click navigation
The injection table's row-click reuses `analyticsSelectPodResult(sessionId:)` at
`MainView.swift:373` (clears the selected card, switches sidebar to All Pods).
Set `requestedDetailTab = .summary` so the pod opens with Summary focused —
matching Phase 3 precedent. There is no Safety-specific tab in the pod detail
panel and this phase does not add one.

## Reference reading
- `docs/analytics-dashboard-plan.md` Phase 4 — the seed; this spec refines.
- `specs/analytics-shell/design.md` — `AnalyticsCard` API + right-pane scene
  state contract (consume as-is, do not widen).
- `specs/analytics-cost/design.md` — trailing-window + composite-endpoint
  conventions; respect verbatim.
- `specs/analytics-reliability-funnel/design.md` — drill section pattern,
  `Path`-based custom chart precedent (we don't use it here, but the
  sectioned-scroll layout is the same).
- `specs/analytics-quality/design.md` — days picker UX, table row-click +
  Summary tab focus, sticky header in drill.
- `packages/daemon/src/db/migrations/004_network_policy.sql` — confirms
  `network_policy` lives on profiles only.
- `packages/daemon/src/db/migrations/007_actions.sql` — original `action_audit`
  schema with `pii_detected` (boolean) and `quarantine_score` (real).
- `packages/daemon/src/db/migrations/064_audit_chain.sql` — hash chain columns
  and the canonical hash payload definition. New `pii_categories` MUST stay
  outside this payload.
- `packages/daemon/src/actions/audit-repository.ts:111-155` — existing per-pod
  `verifyAuditChain`. Brief 05's fleet walker calls this once per distinct
  `pod_id` from `action_audit`.
- `packages/daemon/src/actions/action-engine.ts:182-208` — existing audit insert
  path. Brief 02 layers `pii_categories` + safety_events writes here.
- `packages/daemon/src/api/mcp-proxy-handler.ts:91-105` — quarantine result
  handling; today log-only.
- `packages/daemon/src/issue-watcher/issue-watcher-service.ts:137-167` — threat
  detection at issue ingestion; today log-only.
- `packages/daemon/src/pods/section-resolver.ts:74-82` — quarantine on CLAUDE.md
  section content; today log-only.
- `packages/daemon/src/pods/skill-resolver.ts:62-72` — `sanitizeSkillContent`;
  today silent.
- `packages/daemon/src/pods/pod-manager.ts:262-280` — profile content-processing
  resolution at pod startup; the network_policy_resolved write lives near here
  (after inheritance, before container spawn).
- `packages/daemon/src/api/routes/pods.ts:115-127` — POST /pods free-text
  sanitization. Currently silent; instrument in Brief 04.
- `packages/daemon/src/api/routes/pods.ts:237-277` — Cost / Quality /
  Reliability registration pattern; copy the validation envelope and error
  shape for the new `/pods/analytics/safety` and `/audit-chain/verify` routes.
- `packages/daemon/src/api/routes/pods.test.ts:119-360` — Reliability route
  test pattern (days validation, default behaviour, structural assertions);
  template for safety-route tests.
- `packages/shared/src/sanitize/processor.ts` — `processContent` /
  `processContentDeep`. The `threats[]` array is the canonical source of
  injection pattern hits; don't re-derive.
- `packages/shared/src/sanitize/patterns.ts` — `PII_PATTERNS` (no severity) +
  `INJECTION_PATTERNS` (severity 0..1). Drill copies pattern names from these
  for empty-bucket display.
- `packages/shared/src/sanitize/quarantine.ts` — `ThreatIndicator` shape; the
  source of each `safety_events` row when `kind='injection'`.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/QualityDrillView.swift`
  (added in Phase 3) — the layout this drill mirrors most closely (days picker
  + sectioned scroll + table row click).
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ReliabilityDrillView.swift`
  — error-banner + per-section loading pattern.
- `packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift:1048` —
  `DetailTab` enum; `.summary` is the row-click focus target.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift:344-373` —
  existing `requestedDetailTab` plumbing + `analyticsSelectPodResult`.
- `CLAUDE.md` "CRITICAL — migration numbering" — never reuse a numeric prefix.
  Highest existing is `091`.
- 📋 ADR-015 (model pricing as bundled JSON) — analytics-relevant baseline.
- 📋 ADR-016 (per-attempt phase token taxonomy) — forward-only data convention
  precedent.

## Decisions

Three new ADRs introduced by this phase. Full text in `docs/decisions/`.

- **ADR-018**: `safety_events` table covers fleet-wide detection across all
  active untrusted-input sources, not just issue-watcher.
- **ADR-019**: `pii_categories` column on `action_audit` lives outside the
  hash-chain payload — preserves tamper-evidence on existing rows.
- **ADR-020**: `pods.network_policy_resolved` snapshots the effective policy at
  provisioning time so historical aggregates are immutable.
