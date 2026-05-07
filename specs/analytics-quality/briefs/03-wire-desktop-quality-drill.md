---
title: "Wire desktop Quality card and drill view"
depends_on: [02-add-quality-analytics-endpoint]
acceptance_criteria: []
touches:
  - packages/desktop/Sources/AutopodClient/Types/QualityAnalyticsResponse.swift
  - packages/desktop/Sources/AutopodClient/DaemonAPI.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/QualityDrillView.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift
  - packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift
  - packages/desktop/Tests/AutopodClientTests/QualityAnalyticsResponseTests.swift
does_not_touch:
  - packages/daemon/
  - packages/shared/
  - packages/desktop/Sources/AutopodUI/Views/Detail/
  - packages/desktop/Sources/AutopodUI/Views/Detail/SummaryTab.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/DetailPanelView.swift
---

## Task

Light up the Quality drill in the macOS app on top of the new
`/pods/analytics/quality` endpoint that Brief 02 ships. Two visible
changes:

1. The Quality card on Analytics → Overview gains a sparkline, a delta vs
   prior window, and a `"N red pods"` sub-line — same affordance Cost and
   Reliability already have.
2. Clicking the Quality card opens a real drill view in the right pane:
   band chips (`All / Red / Yellow / Green`) + days picker + histogram +
   seven reason tiles + filterable, sortable scores table. Clicking a row
   jumps to All Pods with the Summary tab focused (existing
   `requestedDetailTab` plumbing — `MainView.swift:347`).

The current inline `QualityDrillView` in `AnalyticsView.swift:169-365`
becomes a standalone file (`QualityDrillView.swift`). The replacement is
driven entirely by the `QualityAnalyticsResponse` payload — no fan-out,
no per-row API calls.

Brief 01 already collapsed the analytics sidebar to a single row. This
brief assumes that simplification has landed (or is landing in parallel)
— the drill is reached via the Overview Quality card, not via a sidebar
sub-row.

## Touches

- `packages/desktop/Sources/AutopodClient/Types/QualityAnalyticsResponse.swift`
  (new) — Codable struct mirroring the TS `QualityAnalyticsResponse`
  field-for-field. Use the existing
  `ReliabilityAnalyticsResponse.swift` and `CostAnalyticsResponse.swift`
  as the precedent for nested struct shape, optionality, and
  CodingKeys (daemon emits camelCase JSON — no key conversion needed).
  Reuse `PodQualityScore` from
  `packages/desktop/Sources/AutopodClient/Types/PodQualityScore.swift`
  for the `scores` array element.
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` — add
  `getQualityAnalytics(days: Int) async throws -> QualityAnalyticsResponse`
  next to `getReliabilityAnalytics` (`DaemonAPI.swift:268`). Same
  signature shape: `days` query param, returns the typed response.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift`
  — enrich the Quality `AnalyticsCard` (currently lines ~84-96 next to
  Cost) with sparkline + delta + sub-line. Remove the inline
  `QualityDrillView` struct (lines 169-365) — extracted to its own file.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/QualityDrillView.swift`
  (new) — the new drill view. See "Drill view structure" below.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift`
  — add `loadQuality: (() async throws -> QualityAnalyticsResponse)?`
  parameter alongside the existing `loadCost` / `loadReliability`
  closures; route it into `QualityDrillView` when the Quality card is
  selected.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` —
  add `loadQualityAnalytics` next to `loadCostAnalytics` /
  `loadReliabilityAnalytics`; thread it through `AnalyticsRightPaneView`.
  On row-click in the drill, route via the existing
  `Self.analyticsSelectPodResult(sessionId:)` helper and additionally
  set `requestedDetailTab = .summary` (precedent at
  `MainView.swift:347`).
- `packages/desktop/Tests/AutopodClientTests/QualityAnalyticsResponseTests.swift`
  (new) — JSON decode coverage. Mirror
  `ReliabilityAnalyticsResponseTests.swift` and
  `CostAnalyticsResponseTests.swift`.

## Does not touch

- `packages/daemon/` — server side is owned entirely by Brief 02.
- `packages/shared/` — TS contract is owned by Brief 02.
- `packages/desktop/Sources/AutopodUI/Views/Detail/` — `DetailTab` enum
  is unchanged. `SummaryTab.swift` already hosts `SessionQualityCard`
  (line 39) — no per-pod-detail changes in this brief.

## Drill view structure

`QualityDrillView` is a single SwiftUI `View` consuming a closure
`load: () async throws -> QualityAnalyticsResponse` and an
`onSelectPod: (String) -> Void` callback.

State:
- `@State private var response: QualityAnalyticsResponse?`
- `@State private var selectedBand: QualityBand = .all`
  (enum: `all`, `red`, `yellow`, `green`)
- `@State private var days: Int = 30`
- `@State private var sortColumn: ScoresColumn = .score`
- `@State private var sortAscending: Bool = true`
- `@State private var loadError: String?`

Layout (top → bottom inside a `ScrollView`):
1. **Header row** — band chips + days picker (`Picker` with
   `7 / 14 / 30 / 60 / 90`). Changing days triggers a fresh `load`.
2. **Histogram** — `Chart` (Swift Charts) of
   `response.distribution`. Bar color per band threshold using
   `analyticsScoreColor` (`AnalyticsView.swift:504`). 10 bars, fixed
   ordering.
3. **Reason tiles** — wrap grid of 7 tiles. Each tile reads a counter
   from `response.reasons` (after band filtering — see "Band-chip
   semantics"). Layout is `LazyVGrid` with adaptive columns ~180pt.
4. **Scores table** — same columns as today's
   `QualityDrillView` (`AnalyticsView.swift:268-365`): Score, Profile,
   Runtime, Model, Cost, Completed, Pod. Sortable headers (header click
   toggles asc/desc). Row click → `onSelectPod(score.podId)`.

States:
- **Loading:** `ProgressView` centered.
- **Empty:** `"No completed pods scored in the last \(days) days."`
  centered when `response.summary.totalPodsScored == 0`.
- **Error:** red caption text under the header (precedent:
  `AnalyticsView.swift:226-233`).

### Band-chip semantics

A band chip filters BOTH the table AND the reason tiles:
- Table: only rows where the score's band matches the chip.
- Reason tiles: count only those filtered pods that triggered each signal.
  Implement client-side over the `scores` array using the same signal
  thresholds the daemon uses (mirror Brief 02's `reasons` definitions —
  `readEditRatio < 1 && editCount > 0`, `editsWithoutPriorRead > 0`,
  `userInterrupts > 0`, `validationPassed === false`,
  `prFixAttempts > 0`, `editChurnCount > 0`, `tellsCount > 0`).

When `selectedBand == .all`, the tile counts equal `response.reasons.*`
verbatim — keep that as a fast path; the recompute only runs when a
specific band is selected.

### Days-picker semantics

Changing the days value re-invokes the `load` closure with the new
value and replaces the stored `response`. While loading, render the
`ProgressView` (don't blank the whole drill — keep the header sticky so
the picker stays clickable).

## Constraints

From `design.md` → Contracts: Swift type mirrors TS field-for-field. No
custom CodingKeys unless the daemon emits a name that would clash with a
Swift keyword.

From `design.md` → UX flows: band chip filtering is purely client-side;
do not refetch on band change. Refetch only on days change.

From `design.md` → Reference reading: the existing
`requestedDetailTab` plumbing in `MainView.swift:344-350` is the routing
contract for "open this pod with Summary tab focused" — do not invent a
new mechanism.

From `purpose.md` → Non-goals: no new Quality `DetailTab` case. The
Quality story on the per-pod detail surface remains
`SessionQualityCard` on the existing Summary tab.

From `purpose.md` → Glossary: band thresholds are Red `<60`, Yellow
`60–79`, Green `80+`. Identical to `analyticsScoreColor` —
do not redefine.

## Test expectations

### Codable roundtrip
`QualityAnalyticsResponseTests.swift` decodes a hand-written JSON fixture
matching the Brief 02 contract. Asserts:
- `summary.totalPodsScored` decodes as `Int`.
- `summary.deltaVsPrior.direction` decodes to one of `up | down | flat`.
- `sparkline` decodes as a non-empty array when `days >= 1`.
- `distribution` decodes with 10 buckets.
- `reasons` decodes all 7 fields.
- `scores` decodes via the existing `PodQualityScore` Codable.
- An empty-fleet payload (`totalPodsScored: 0`, all reason counters 0,
  `scores: []`) decodes without throwing.

### No new Swift unit tests for the drill view
SwiftUI view-level tests are not part of the validation pipeline (Swift
tests don't run in CI — see `purpose.md` → Non-goals discussion). Lean
on diff review + manual eyeball for:
- Band chip toggling re-filters the table and reason tiles.
- Days picker re-fetches and updates the histogram.
- Row click navigates to the All Pods list with Summary tab focused.

### Manual smoke
1. Open Analytics → Overview. Confirm the Quality card now shows a
   sparkline, delta, and `"N red pods"` sub-line (when applicable).
2. Click the Quality card. The right pane shows the drill view with
   band chips, days picker, histogram, 7 reason tiles, and scores table.
3. Click `Red`. Table shrinks to red-band pods; reason tiles update to
   reflect that subset.
4. Change the days picker to `7`. Re-fetch happens; data updates.
5. Click a table row. App switches to All Pods, the clicked pod is
   selected, the detail pane opens to the Summary tab.
6. Confirm no `"ships in Phase N"` placeholder appears anywhere.

## Risks / pitfalls

- **`PodQualityScore` shape drift.** The drill table renders from
  `scores: [PodQualityScore]`. The existing Swift `PodQualityScore`
  type already has all the columns the table needs; if Brief 02 adds a
  field that the daemon serializes by default, the Swift decoder must
  not be strict-mode (verify with the existing
  `JSONDecoder` config in `DaemonAPI.swift`). Add `nil`-safe optionals
  for any newly introduced field rather than failing the whole decode.
- **Band-chip recompute cost.** If a fleet ends up with thousands of
  scored pods in one window the client-side reason recompute could
  stutter on band toggle. Run the recompute on a single pass through
  the array (one `for` loop, seven counters); don't `.filter()` seven
  times. If that proves slow, drop down a `Task.detached` so the UI
  stays responsive.
- **Card sub-line absence.** Cost and Reliability cards do not have a
  sub-line; if the existing `AnalyticsCard` API does not accept one,
  add an optional `subline: String?` parameter rather than forking the
  card. Stay backwards-compatible — Cost and Reliability calls keep
  passing `nil`.
- **`AnalyticsRightPaneView` signature change.** Adding `loadQuality`
  to `AnalyticsRightPaneView` is a breaking-call-site change — every
  call site must add the new closure. Check `MainView.swift` is the
  only caller; if there are other call sites (preview / test scaffolds),
  update them.
- **Charts framework availability.** `import Charts` requires macOS 13+.
  The project already uses Swift Charts in
  `packages/desktop/Sources/AutopodUI/Views/Analytics/` — confirm before
  adding a new import.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run `xcodebuild` for the desktop target; verify the app compiles
   and the new view renders without warnings.
3. Manual smoke per the steps above.
4. Commit and push.
