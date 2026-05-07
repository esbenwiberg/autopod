---
title: "Wire desktop Safety card + drill view"
depends_on: [05-add-safety-analytics-and-audit-verify-endpoints]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodClient/Types/SafetyAnalyticsResponse.swift
  - packages/desktop/Tests/AutopodClientTests/SafetyAnalyticsResponseTests.swift
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/SafetyDrillView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/cli/
  - packages/escalation-mcp/
  - packages/validator/
---

## Task

Surface the Safety card on the analytics dashboard and the
five-section drill in the right pane. All data is consumed verbatim
from the endpoints Brief 05 ships.

1. **Codable mirror** — `SafetyAnalyticsResponse.swift` decodes the
   exact shape from `design.md` → Contracts. Mirrors
   `ReliabilityAnalyticsResponse.swift` / `QualityAnalyticsResponse.swift`
   patterns.

2. **Daemon API client** — `DaemonAPI.swift` gains
   `getSafetyAnalytics(days:)` (alongside `getReliabilityAnalytics` /
   `getQualityAnalytics`) and `verifyAuditChain()` (POST helper).

3. **Card kind enum** — `AnalyticsCardKind.swift` extends with
   `.safety`. Existing exhaustive switches break compile; fix all
   call sites in this brief.

4. **Right-pane routing** — `AnalyticsRightPaneView.swift` adds a
   `.safety` switch case routing to the new drill view.

5. **Card wiring** — `AnalyticsView.swift` adds the Safety card with
   the standard `AnalyticsCard` API: pre-formatted value, sparkline,
   delta. Sub-line `"\(piiCount) PII · \(quarantineCount) quar ·
   \(injectionCount) inj"` rendered below the value when
   `totalEvents > 0 || quarantineCount > 0`. Suppressed otherwise.

6. **Drill view** — `SafetyDrillView.swift` (new), five sections in
   scroll order (`design.md` → UX flows → Drill view):
   1. PII histogram by pattern.
   2. Quarantine score histogram (10 buckets).
   3. Injection attempts table (When / Source / Pattern / Severity /
      Pod). Row click → reuse `analyticsSelectPodResult(sessionId:)`
      with `requestedDetailTab = .summary`. `__pre_creation__` rows
      non-clickable.
   4. Audit-chain integrity widget with "Verify now" button →
      POST `/audit-chain/verify` → refresh.
   5. Network-policy distribution.

   Header: sticky days picker (7 / 14 / 30 / 60 / 90; default 30).
   Empty / loading / error states per `ReliabilityDrillView` /
   `QualityDrillView` patterns.

7. **`MainView.swift`** — pass `loadSafetyAnalytics` and
   `verifyAuditChain` closures into the existing `AnalyticsView(...)`
   call site, mirroring `loadReliabilityAnalytics` /
   `loadQualityAnalytics`.

## Touches

- `packages/desktop/Sources/AutopodClient/Types/SafetyAnalyticsResponse.swift`
  (new) — Codable struct mirroring the TS contract.
- `packages/desktop/Tests/AutopodClientTests/SafetyAnalyticsResponseTests.swift`
  (new) — JSON decode coverage modelled on
  `ReliabilityAnalyticsResponseTests.swift`.
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` —
  `getSafetyAnalytics(days:)` + `verifyAuditChain()`.
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift`
  — extend enum with `.safety`. Fix exhaustive switches.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`
  — `.safety` case → `SafetyDrillView`.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift`
  — Safety card data wiring.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/SafetyDrillView.swift`
  (new) — five-section drill.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` —
  pass closures into the analytics view.

## Does not touch

- `packages/daemon/` — Briefs 01-05 own.
- `packages/shared/` — Brief 01 owns the contract source. Desktop
  mirrors in Swift only.
- `packages/cli/` — no CLI changes for this phase.
- `packages/escalation-mcp/`, `packages/validator/` — out of scope.

## Constraints

- **Card API is locked** (Phase 0,
  `specs/analytics-shell/design.md`): `title: String, value: String
  (pre-formatted), sparkline: [Double]?, delta: AnalyticsCardDelta?,
  isSelected: Bool, onClick`. Don't add fields. Pre-format strings
  (the daemon already does for cost; for safety the formatting is
  mostly trivial — `String(totalEvents)`).
- **Sub-line under value** is a single-line string with U+00B7 middle
  dots: `"\(piiCount) PII · \(quarantineCount) quar ·
  \(injectionCount) inj"`. Suppressed entirely when both
  `totalEvents == 0` and `quarantineCount == 0`. The sub-line is
  rendered by `AnalyticsCard` itself if the API supports it; if not,
  add a small overlay and document.
- **Sparkline mapping**: the daemon returns
  `[{day, count}]` array. Map to `[Double]` for the card via
  `summary.sparkline.map { Double($0.count) }`.
- **Days picker values**: `7 / 14 / 30 / 60 / 90`. Default 30.
  Re-fetch on change. Mirror `QualityDrillView` exactly.
- **Drill section order is locked** (design.md). Don't reorder.
- **Row-click navigation**: reuse
  `analyticsSelectPodResult(sessionId:)` at `MainView.swift:373`
  with `requestedDetailTab = .summary`. No new tab is introduced for
  Safety in the pod detail panel.
- **Audit chain widget states**:
  - `valid: true` → green checkmark + entries/pods caption.
  - `valid: false` → red X + first-mismatch caption.
  - `valid: null` → neutral chip "No verification on file."
  - "Verify now" button shows loading state during POST; on success,
    refresh the safety endpoint to repopulate the widget.
- **`__pre_creation__` rows**: non-clickable in the injection table.
  Render with a muted style and no chevron. The aggregator already
  guarantees `profile == nil` for these rows.
- **Network-policy bucket order**: `allow-all`, `restricted`,
  `deny-all`, `unknown` — left to right or top to bottom.
- **No backfill UI**: the drill is read-only. There's no "edit" or
  "configure" surface — operator-grade visibility only.
- **Error banner** mirrors `ReliabilityDrillView`'s pattern.
- **Loading skeleton**: per-section `ProgressView`. Don't block the
  whole drill on one section.
- **No new build / lint commands** — Swift package builds via
  Xcode/`xcodebuild`. The desktop is not in the pnpm workspace;
  validation pipeline doesn't gate it.

## Test expectations

- **Codable round-trip** (`SafetyAnalyticsResponseTests.swift`):
  - Full populated payload: every field decodes; nested types
    decode (`byPattern`, `byPod` with `topInjections`,
    `auditChain`, `networkPolicy`).
  - `auditChain` all-null shape decodes (when no verification has
    been run).
  - `byPod` entry with `podId == "__pre_creation__"` and
    `profile == nil` decodes.
  - `summary.deltaVsPrior.direction` decodes for each enum case
    (`up`, `down`, `flat`).
- **Card rendering** (manual / smoke): with seeded backend data,
  the card shows the right value/sparkline/delta and the sub-line
  formatting matches.
- **Drill rendering** (manual): all five sections render against a
  populated payload; empty payload shows the empty-state copy in
  each section without crashing.
- **No new XCUI test budget**: SwiftUI snapshot or full UI tests are
  not part of the existing desktop test posture (see
  `ReliabilityDrillView` / `QualityDrillView`'s coverage). Match
  precedent — Codable test plus manual validation.

This brief ships zero `acceptance_criteria` because the desktop is
not in the pnpm workspace and the validation pipeline can't
exercise SwiftUI views. Verification anchors on:
- Brief 05's `api`-typed ACs proving the contract holds on the
  wire.
- The Codable round-trip test guarding the Swift/TS shape match.
- The diff reviewer for UX layout fidelity.

## Risks / pitfalls

- **Exhaustive switches**: extending `AnalyticsCardKind` with
  `.safety` will fail to compile every site that switches on the
  enum without a default case. Find them all with
  `rg 'AnalyticsCardKind' packages/desktop/Sources/` and add the
  case in this brief — don't ship a temporary `default:` branch.
- **Sub-line layout**: the existing `AnalyticsCard` may not have a
  sub-line slot. Check the component; if missing, add it as an
  optional parameter (additive, doesn't break Cost / Quality /
  Reliability cards). If touching `AnalyticsCard.swift` itself,
  add it to `touches`.
- **Days picker re-fetch**: cancel any in-flight request when the
  user changes days, otherwise stale responses can paint over fresh
  ones. Mirror `QualityDrillView`'s cancellation pattern.
- **"Verify now" UX**: if the chain is large the verifier may take
  several seconds. The button must show progress. Don't run a
  background poll on completion — just re-fetch the safety endpoint
  once the POST returns.
- **`profile` lookup for `byPod` rows**: the response includes
  `profile: string | null`. The desktop should not have to dial
  `/profiles` to render the table — the daemon already populates
  this field in Brief 05. Keep the wire contract intact.
- **Severity rendering**: 0..1 floats. Format as `"\(severity ?? "—")"`
  with two decimals (e.g. `0.85`). PII rows show `—`.
- **Charts framework**: SwiftUI Charts (`BarMark`) per
  `QualityDrillView` precedent. Don't introduce a third-party
  charts dependency.
- **Phase 0 sidebar sub-row**: the Safety sub-row exists but is
  `.disabled(true)`. Enabling it is part of *this* brief — flip the
  flag in the sidebar where the convention is established (see
  `specs/analytics-shell/design.md`).

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Build the desktop target via `xcodebuild` or Xcode and exercise
   the card + drill manually against a daemon running the new
   endpoints from Brief 05.
3. Commit and push.
