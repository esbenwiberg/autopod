---
title: "Wire desktop Escalations card and EscalationsDrillView"
depends_on: [01-add-escalations-analytics-endpoint]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodClient/Types/EscalationsAnalyticsResponse.swift
  - packages/desktop/Tests/AutopodClientTests/EscalationsAnalyticsResponseTests.swift
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/EscalationsDrillView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/cli/
  - packages/escalation-mcp/
  - packages/validator/
---

## Task

Surface the Escalations card on the analytics dashboard and the
three-section drill in the right pane. All data is consumed verbatim
from the endpoint Brief 01 ships.

**Sequencing note:** the parallel spec `analytics-throughput` Brief 02
also extends `AnalyticsCardKind` with `.throughput` and edits the same
exhaustive-switch sites (`AnalyticsRightPaneView`, `AnalyticsView`,
`MainView`). Merge analytics-throughput Brief 02 BEFORE starting this
brief. If the throughput brief is in flight, rebase before opening the
PR for this one. Do not silently add `default:` arms to mask an
incoming `.throughput` case.

1. **Codable mirror** —
   `EscalationsAnalyticsResponse.swift` decodes the exact shape from
   `design.md` → Contracts. Mirrors
   `ReliabilityAnalyticsResponse.swift` /
   `SafetyAnalyticsResponse.swift` /
   `ThroughputAnalyticsResponse.swift` patterns.

2. **Daemon API client** — `DaemonAPI.swift` gains
   `getEscalationsAnalytics(days:)` next to
   `getReliabilityAnalytics`/`getQualityAnalytics`/`getSafetyAnalytics`
   /`getThroughputAnalytics`.

3. **Card kind enum** — `AnalyticsCardKind.swift` extends with
   `.escalations`. Existing exhaustive switches will fail to compile
   until they handle the new case — fix every call site in this
   brief.

4. **Right-pane routing** — `AnalyticsRightPaneView.swift` adds an
   `.escalations` switch case routing to `EscalationsDrillView`.

5. **Card data wiring** — in `AnalyticsView.swift`, wire the
   Escalations card into the existing card-grid:
   - `value`: `"\(Int(round(summary.selfRecoveryRate * 100)))%"`
     (e.g. `"73%"`). When `summary.cohortSize == 0`: value =
     `"—"`.
   - `sparkline`: `summary.dailyHumanCountSparkline.map(\.count)`
     (mapped to `[Double]`). Empty cohort → `nil`.
   - `delta`: built from `summary.selfRecoveryRateDelta`; format
     `String(format: "%+.0fpp", value * 100)`; direction maps to
     the existing up/down/flat enum. Empty current OR prior cohort
     → `nil`. Note: 'up' on this rate is **good** (more autonomy)
     — DO NOT recolour the standard up/down chrome; the operator
     reads the rate semantically.
   - **sub-line under value**: `"N human · M ai"` per the UX flows
     section in `design.md`. `N = humanAttentionCount` (rows, not
     pod count), `M = askAiCount`. Middle dot is U+00B7. Sub-line
     suppressed when both N and M are 0.

6. **Drill view** — new
   `EscalationsDrillView.swift` with three sections in scroll order
   (TTR histogram, per-profile table, blocker patterns table) plus
   a sticky days picker (default 30; values 7/14/30/60/90).
   Re-fetches on picker change. Per-section loading skeletons;
   per-section empty states; error banner above sections on fetch
   failure (mirroring `ReliabilityDrillView` /
   `ThroughputDrillView`).

   - **`ask_human` TTR histogram** — `Chart` with 8 `BarMark`s in
     the locked label order from `askHumanTtr.buckets`. Bar height
     = `bucket.count`. Cell label shows the count above each bar.
     **Section header:** `"X resolved · Y open"` where X is
     `askHumanTtr.resolvedCount` and Y is `askHumanTtr.openCount`.
     **Section footer:** `"max: \(formatDuration(maxSeconds))"`,
     suppressed when `maxSeconds == 0`. Empty state shown when
     `resolvedCount == 0`: `"No ask_human escalations resolved in
     last N days."` (header and footer still render above).
     Stats-only — no row click, no expansion.

   - **Per-profile table** — three columns: profile · pods ·
     escalated · rate. Server-supplied ordering — do NOT re-sort
     client-side. Display `rate` as
     `"\(Int(round(rate * 100)))%"`. The synthetic
     `<small profiles>` row, when present, renders with a
     smaller-text caption "n profiles below 5 pods" beneath the
     row label (compute n by counting how many original profiles
     folded in — derive on the desktop side from
     `podCount / sum-of-podCount` if needed; alternatively render
     a static "small profiles" caption without the count if
     deriving feels brittle). Empty state:
     `"No terminal pods in last N days."`. Stats-only — no row
     click, no expansion.

   - **Blocker patterns table** — two columns: description ·
     count. Each row is a `DisclosureGroup`. Expanding shows the
     up-to-10 `podIds[]` as a vertical list of pod-id chips
     (similar styling to the throughput drill heatmap-cell
     expansion), plus a `+ N more` indicator when
     `count > podIds.count`. Each pod-id chip is clickable →
     calls `onSelectPod(podId)`. Empty state:
     `"No report_blocker escalations in last N days."`.

7. **MainView wiring** — `MainView.swift` passes
   `loadEscalations: { days in try await daemonAPI.getEscalationsAnalytics(days: days) }`
   into the existing `AnalyticsView(...)` call site (one-line
   addition, identical pattern to the prior phases'
   `loadReliability` / `loadQuality` / `loadSafety` /
   `loadThroughput` closures).

## Touches

- `packages/desktop/Sources/AutopodClient/Types/EscalationsAnalyticsResponse.swift` (new)
- `packages/desktop/Tests/AutopodClientTests/EscalationsAnalyticsResponseTests.swift` (new)
- `packages/desktop/Sources/AutopodUI/Views/Analytics/EscalationsDrillView.swift` (new)
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift`
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift`
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift`
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift`

## Does not touch

- `packages/daemon/` — endpoint and aggregator already shipped in
  Brief 01.
- `packages/shared/` — TS contract is the source of truth and is
  owned by Brief 01; do not duplicate.
- `packages/cli/`, `packages/escalation-mcp/`,
  `packages/validator/` — unrelated.

## Constraints

- Must consume the `AnalyticsCard` API verbatim (Phase 0 lock):
  `title`, `value`, `sparkline`, `delta`, `isSelected`, `onClick`.
  Do not widen.
- `AnalyticsCardKind` extends by exactly `.escalations`. Every
  exhaustive-switch site must be updated in this brief.
- Server-supplied ordering for `perProfile` and `blockerPatterns`
  is authoritative; do not re-sort client-side.
- `askHumanTtr.buckets` is always exactly 8 entries — render in
  the order provided (the daemon emits them in the locked label
  order); do not reshuffle.
- `dailyHumanCountSparkline` length is always `days`; use it
  unmodified for the card sparkline.
- Blocker pattern row click reuses
  `analyticsSelectPodResult(sessionId:)` at
  `MainView.swift:344-373`; set `requestedDetailTab = .summary` per
  Phase 3 / 5a precedent.
- Drill structure mirrors `ReliabilityDrillView` /
  `QualityDrillView` / `SafetyDrillView` /
  `ThroughputDrillView` — sticky days picker, per-section
  loading + empty states, error banner above sections.
- 'up' direction on the rate delta is GOOD (more autonomy). Do
  NOT swap colour semantics. Operator interprets the rate
  semantically; the chrome stays consistent.

## Test expectations

`EscalationsAnalyticsResponseTests.swift` (modeled on
`ReliabilityAnalyticsResponseTests.swift` and
`ThroughputAnalyticsResponseTests.swift`):

- **Full happy-path JSON decode** — every key in the contract
  decodes into the expected Swift type. Includes a non-empty
  `perProfile` (with the synthetic `<small profiles>` row), a
  non-empty `blockerPatterns` (with one pattern at length-10
  podIds + `count: 25`), and `askHumanTtr.buckets` with all 8
  entries.

- **Minimal payload decode** — empty `perProfile`, empty
  `blockerPatterns`, all-zero `askHumanTtr.buckets`,
  `summary.cohortSize == 0`, `selfRecoveryRate == 1.0`.

- **Snake-case key handling** — confirm the JSONDecoder strategy
  matches the rest of the AutopodClient (mirror what
  `ReliabilityAnalyticsResponseTests` does).

- **Direction enum decode** — `'up'` / `'down'` / `'flat'` all
  decode for `selfRecoveryRateDelta.direction`.

- **Bucket label decode** — verify the 8 fixed labels
  (`<1m, 1–5m, 5–15m, 15m–1h, 1–4h, 4–12h, 12–24h, >24h`) decode
  as Swift strings byte-for-byte (note the en-dash `–`, not
  hyphen-minus `-`).

- **Synthetic-profile-row decode** — fixture with
  `profile: "<small profiles>"` decodes without special-casing
  (it's just a string).

The drill view itself is exercised via SwiftUI Previews (which
don't run in CI) and the diff reviewer; no XCTest coverage. This
matches the pattern of every prior analytics phase
(analytics-safety/06, analytics-reliability/02, analytics-quality/03,
analytics-throughput/02 all ship `acceptance_criteria: []`).

## Risks / pitfalls

- **AnalyticsCardKind merge conflict** — analytics-throughput Brief
  02 also touches this enum and the same exhaustive-switch sites.
  Merge throughput Brief 02 first; if not feasible, rebase before
  opening the PR for this brief and resolve the enum + switch
  cases by including BOTH new cases.
- **En-dash vs hyphen-minus in bucket labels** — the contract uses
  en-dash (`–`, U+2013) in bucket labels (e.g. `1–5m`). Codable
  decode should be byte-for-byte; if a test fails on the dash,
  inspect the source byte rather than guessing.
- **Rate-delta colour semantics** — 'up' is good here. Do not
  override the standard chrome to invert colours; the operator
  reads the rate semantically. If a reviewer pushes for
  inversion, defer to a separate UI polish ticket.
- **Sub-line dynamic disclosure** — the
  `"N human · M ai"` sub-line suppresses entirely when both N and
  M are 0. The card still renders the value (`—`) and the
  sparkline (`nil`); just the sub-line collapses.
- **Empty-cohort value rendering** — `cohortSize == 0` → value is
  `"—"`, NOT `"100%"`. The math returns 1.0 for vacuous truth but
  the UI hides it because "100% self-recovery with zero pods" is
  noise, not signal.
- **Blocker description copy** — descriptions are user-supplied
  (agent-supplied, really) free text. They may contain newlines,
  emoji, or long single-line text. Truncate visually with
  `lineLimit(1)` + ellipsis in the row label; the full string
  shows in the expanded section header inside the
  `DisclosureGroup`.
- **Switch exhaustiveness** — extending `AnalyticsCardKind` with
  `.escalations` will produce compile errors at every existing
  exhaustive switch (sidebar mapping, right-pane routing, card
  styling). Fix all of them in this brief; do not silently add
  `default:` arms to mask new cases.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
