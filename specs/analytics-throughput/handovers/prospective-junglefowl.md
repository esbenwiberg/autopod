# Handover — prospective-junglefowl (Brief 02: Desktop card + drill)

## What was built

Implemented the Throughput analytics card and three-section drill view for the macOS SwiftUI desktop app, consuming the daemon endpoint shipped in Brief 01 verbatim.

### Files created
- `packages/desktop/Sources/AutopodClient/Types/ThroughputAnalyticsResponse.swift` — Codable mirror of the TS contract. Key: `LoadBearingStatus.awaitingInput` has raw value `"awaiting_input"` (snake_case JSON key handled via explicit raw value, NOT `.convertFromSnakeCase` — the rest of AutopodClient uses camelCase JSON keys natively).
- `packages/desktop/Sources/AutopodUI/Views/Analytics/ThroughputDrillView.swift` — Three-section drill: hour×day heatmap (Calendar.current bucketing), queue-depth time-series (AreaMark mean + LineMark max), time-in-status box plot (BarMark p25→p75, RuleMark p50, whisker p75→p90, PointMark max).
- `packages/desktop/Tests/AutopodClientTests/ThroughputAnalyticsResponseTests.swift` — 8 tests: round-trip decode, minimal, 5000-entry truncated cohort, direction enum, LoadBearingStatus, ThroughputPodStatus, DST bucketing.

### Files modified
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` — added `getThroughputAnalytics(days:)` after `getSafetyAnalytics`
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift` — added `.throughput`; all exhaustive switches updated in the same commit
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift` — added `.throughput` case routing to `ThroughputDrillView`
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` — wired throughput card (value/sparkline/delta/subline) into card grid, added concurrent fetch task
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` — wired `loadThroughputAnalytics` closure and `onThroughputSelectPod` callback

## Deviations from the brief

None. All 8 brief steps implemented as specified. `onThroughputSelectPod` follows the exact `analyticsSelectPodResult` + `requestedDetailTab = .summary` pattern from the brief constraints.

## Contracts / interfaces the next pod must know about

- **`ThroughputAnalyticsResponse.swift`** is the Swift mirror of the TS contract. If the daemon endpoint shape changes, this file must change in lockstep.
- **`AnalyticsCardKind`** now has `.throughput`. Every exhaustive switch in the codebase was updated; if you add a new card kind, the same pattern applies.
- **`AnalyticsView.swift`** has a new `loadThroughputAnalytics` parameter alongside `loadReliabilityAnalytics` / `loadQualityAnalytics` / `loadSafetyAnalytics`. `MainView.swift` wires all four.

## Files to leave alone (unless there's a good reason)

- `ThroughputDrillView.swift` — the heatmap bucketing logic is DST-safe and has a test; do not simplify date math naively.
- `ThroughputAnalyticsResponse.swift` — `LoadBearingStatus.awaitingInput = "awaiting_input"` raw value is intentional; do not auto-derive it.

## Discovered constraints / landmines

- **No `.convertFromSnakeCase`**: AutopodClient's `request(_:_:query:)` helper uses a plain `JSONDecoder()` (not snake_case strategy). The only non-camelCase JSON key in this contract is `awaiting_input` → handled by explicit raw value on the enum case. If you add more snake_case keys, you must use explicit raw values.
- **Queue-depth parsing**: ISO parsing happens once in `fetchData()` and stored in `@State parsedQueueDepth`. The `ThroughputQueueDepthSectionView` takes `[(date: Date, max: Double, mean: Double)]`, not the raw `[QueueDepthBucket]`. This was a simplify fix to avoid re-parsing 2160 entries on every layout pass.
- **Module-level formatters**: `nonisolated(unsafe) private let _tputIsoFullFmt` / `_tputIsoBasicFmt` are cached at module scope. Same pattern as `AnalyticsView.swift`'s cached formatters.
- **MTTM sub-line**: `formatMttmSeconds` returns `nil` for `0` (suppresses the MTTM part). `backlog == 0` suppresses the queue part. Whole sub-line nil when both suppress. Logic lives as a free function in `AnalyticsView.swift`.

## Build / test status at handover

- `npx pnpm build` — clean (5 tasks, 5 cached)
- `npx pnpm test` — 2466 tests pass (137 test files)
- Branch: `autopod/complicated-whippet` (2 commits from this pod)
