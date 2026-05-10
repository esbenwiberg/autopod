---
title: "Wire desktop Throughput card and ThroughputDrillView"
depends_on: [01-add-throughput-analytics-endpoint]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodClient/Types/ThroughputAnalyticsResponse.swift
  - packages/desktop/Tests/AutopodClientTests/ThroughputAnalyticsResponseTests.swift
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/ThroughputDrillView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/cli/
  - packages/escalation-mcp/
  - packages/validator/
---

## Task

Surface the Throughput card on the analytics dashboard and the
three-section drill in the right pane. All data is consumed verbatim
from the endpoint Brief 01 ships.

1. **Codable mirror** —
   `ThroughputAnalyticsResponse.swift` decodes the exact shape from
   `design.md` → Contracts. Mirrors
   `ReliabilityAnalyticsResponse.swift` /
   `SafetyAnalyticsResponse.swift` patterns.

2. **Daemon API client** — `DaemonAPI.swift` gains
   `getThroughputAnalytics(days:)` next to
   `getReliabilityAnalytics`/`getQualityAnalytics`/`getSafetyAnalytics`.

3. **Card kind enum** — `AnalyticsCardKind.swift` extends with
   `.throughput`. Existing exhaustive switches will fail to compile
   until they handle the new case — fix every call site in this
   brief.

4. **Right-pane routing** — `AnalyticsRightPaneView.swift` adds a
   `.throughput` switch case routing to `ThroughputDrillView`.

5. **Card data wiring** — in `AnalyticsView.swift`, wire the
   Throughput card into the existing card-grid:
   - `value`: `String(format: "%.1f", summary.podsPerDay)` (e.g.
     `"3.4"`). When `summary.podsPerDay == 0`: value = `"0"`.
   - `sparkline`: `summary.podsPerDaySparkline.map(\.count)` (mapped
     to `[Double]`). Empty cohort → `nil`.
   - `delta`: built from `summary.podsPerDayDelta`; format
     `String(format: "%+.1f /day", value)`; direction maps to the
     existing up/down/flat enum. Empty cohort → `nil`.
   - **sub-line under value**: `"MTTM Xh Ym · N in queue"` per the
     UX flows section in `design.md`. Hours/minutes/seconds
     formatter handles unit selection. Whole sub-line suppressed
     when both halves suppress.

6. **Drill view** — new
   `ThroughputDrillView.swift` with three sections in scroll order
   (heatmap, queue-depth, time-in-status box plot) plus a sticky
   days picker (default 30; values 7/14/30/60/90). Re-fetches on
   picker change. Per-section loading skeletons; per-section empty
   states; error banner above sections on fetch failure
   (mirroring `ReliabilityDrillView`).

   - **Heatmap** — buckets `cohort[].completedAt` (UTC ISO) into
     7 × 24 cells using `Calendar.current` (user-local TZ). Cell
     color is `Color.accent.opacity(count / maxCount)` overlay;
     cell label shows the count. Cells with count > 0 are
     clickable; clicking expands a `DisclosureGroup` listing up
     to 10 pods (ordered by completedAt DESC) with an `+ N more`
     overflow indicator. Each pod row clickable → calls
     `onSelectPod(podId)`. When `cohortTruncated == true`,
     show "showing the most recent 5 000 of N pods" caption beneath
     the heatmap. Empty state: `"No completed pods in last N
     days."`.

   - **Queue-depth time-series** — `Chart` with two layers:
     `mean` rendered as a shaded `AreaMark` from baseline; `max`
     rendered as a solid `LineMark` on top. X-axis = local time
     (user TZ); Y-axis = depth in pods. Empty state (when
     `queueDepth` is empty or all-zero): `"No queue history in
     last N days."`.

   - **Time-in-status box plot** — `Chart` with one row per
     `LoadBearingStatus` in the fixed order
     `[queued, running, validating, awaiting_input]`. Each row:
     `BarMark` from p25 to p75 (the box), `RuleMark` at p50,
     `RuleMark` from p75 to p90 (whisker), `PointMark` at max.
     Sub-label per row: `"\(status) · n=\(sampleCount)"`. States
     with `sampleCount == 0` render as `"—"`. Section-level empty
     state when all four states have `sampleCount == 0`:
     `"No status-transition history in last N days."`.

7. **MainView wiring** — `MainView.swift` passes
   `loadThroughput: { days in try await daemonAPI.getThroughputAnalytics(days: days) }`
   into the existing `AnalyticsView(...)` call site (one-line
   addition, identical pattern to the prior phases'
   `loadReliability`/`loadQuality`/`loadSafety` closures).

## Touches

- `packages/desktop/Sources/AutopodClient/Types/ThroughputAnalyticsResponse.swift` (new)
- `packages/desktop/Tests/AutopodClientTests/ThroughputAnalyticsResponseTests.swift` (new)
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ThroughputDrillView.swift` (new)
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
- `AnalyticsCardKind` extends by exactly `.throughput`. Every
  exhaustive-switch site must be updated in this brief.
- Heatmap timezone bucketing uses `Calendar.current` — never UTC.
  The contract returns UTC ISO strings; the Swift side does the
  local conversion.
- Heatmap-cell row click reuses
  `analyticsSelectPodResult(sessionId:)` at
  `MainView.swift:344-373`; set `requestedDetailTab = .summary` per
  Phase 3 precedent.
- Drill structure mirrors `ReliabilityDrillView` /
  `QualityDrillView` / `SafetyDrillView` — sticky days picker,
  per-section loading + empty states, error banner above sections.

## Test expectations

`ThroughputAnalyticsResponseTests.swift` (modeled on
`ReliabilityAnalyticsResponseTests.swift`):

- **Full happy-path JSON decode** — every key in the contract
  decodes into the expected Swift type. Includes a non-empty
  `cohort`, a non-empty `queueDepth`, and `timeInStatus` with all
  four states.
- **Minimal payload decode** — empty `cohort`, all-zero
  `queueDepth`, `timeInStatus` with all-zero stats; assert
  `cohortTruncated == false`.
- **Truncated payload decode** — `cohortTruncated == true` plus a
  cohort of length 5 000.
- **Snake-case key handling** — confirm the JSONDecoder strategy
  matches the rest of the AutopodClient (mirror what
  `ReliabilityAnalyticsResponseTests` does — likely
  `keyDecodingStrategy = .convertFromSnakeCase` or similar; check
  the existing test).
- **Direction enum decode** — `'up'` / `'down'` / `'flat'` all
  decode.

The drill view itself is exercised via SwiftUI Previews (which
don't run in CI) and the diff reviewer; no XCTest coverage. This
matches the pattern of every prior analytics phase
(analytics-safety/06, analytics-reliability/02, analytics-quality/03
all ship `acceptance_criteria: []`).

If a small unit test is feasible for the heatmap bucketing logic
(UTC ISO → user-local hour×day index against a fixed calendar/TZ),
add it to `ThroughputAnalyticsResponseTests.swift` or a new
`ThroughputDrillBucketingTests.swift`. Otherwise rely on the
diff reviewer.

## Risks / pitfalls

- **Timezone bugs** — DST transitions cause some hours to have 0
  or 2 occurrences in a week. Use Foundation's calendar arithmetic
  rather than naive math. Test with at least one DST-spanning
  fixture.
- **Cohort size on layout** — up to 5 000 pod entries. Bucket once
  on fetch (or on days-picker change); don't rebucket on every
  layout pass. Keep bucketed counts in `@State` derived once.
- **Sub-line formatter** — MTTM in `Xh Ym` when ≥ 3600s, else
  `Ym` when ≥ 60s, else `Ns`. `0s` suppresses; `N in queue == 0`
  suppresses. Whole sub-line suppresses when both suppress.
- **Switch exhaustiveness** — extending `AnalyticsCardKind` with
  `.throughput` will produce compile errors at every existing
  exhaustive switch (sidebar mapping, right-pane routing, card
  styling). Fix all of them in this brief; do not silently add
  `default:` arms to mask new cases.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
