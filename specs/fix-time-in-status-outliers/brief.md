---
title: "Fix Time in Status outlier rendering"
touches:
  - packages/desktop/Sources/AutopodUI/Views/Analytics/ThroughputDrillView.swift
  - packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift
does_not_touch:
  - packages/shared/
  - packages/daemon/
  - packages/desktop/Sources/AutopodClient/Types/ThroughputAnalyticsResponse.swift
  - packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift
---

## Task

Make the Throughput drill's "Time in Status" chart readable when a few `max` values are
hours long but p25-p90 values are minutes long. The chart should optimize the visible scale
for the core distribution, while still making max outliers visible and labeled.

## Why

The current `PointMark` at `box.max` stretches the linear x-axis, so ordinary queued,
running, validating, and awaiting-input durations collapse against zero whenever a single
pod spent many hours in a state. Operators need the common p25-p90 range to stay readable,
without losing the fact that long-tail outliers exist.

## Touches

- `packages/desktop/Sources/AutopodUI/Views/Analytics/ThroughputDrillView.swift`
  updates the time-in-status display logic and chart marks.
- `packages/desktop/Tests/AutopodUITests/ThroughputTimeInStatusDisplayTests.swift`
  adds focused tests for the display-cap and clamping helper.

## Does not touch

- `packages/shared/` and `packages/daemon/` stay unchanged; the backend contract already
  provides the needed `p25`, `p50`, `p75`, `p90`, `max`, and `sampleCount` fields.
- `packages/desktop/Sources/AutopodClient/Types/ThroughputAnalyticsResponse.swift` stays
  unchanged; this is not a wire-format change.
- `AnalyticsView.swift` stays unchanged unless the implementation discovers an unavoidable
  compile issue; the Throughput card summary is not part of this fix.

## Constraints

- Required facts for `autopod-self` run inside the Linux `node22-pw` pod image. Do not
  rely on `swift test` as an Autopod required fact for this desktop work; SwiftUI/AppKit
  verification is human review or optional local Mac validation until a Mac runner exists.
- Preserve the existing section-level empty state:
  `"No status-transition history in last N days."`
- Preserve the existing row order and source data:
  `[queued, running, validating, awaiting_input]`.
- Add a small pure helper in `ThroughputDrillView.swift` for display preparation. Keep it
  `internal` so `@testable import AutopodUI` can exercise it, but keep the SwiftUI section
  view itself private.
- Compute a rendering-only x-axis cap from the core distribution, not from long-tail max:
  - ignore rows with `sampleCount == 0`;
  - `coreUpper = max(p25, p50, p75, p90)` across non-empty rows;
  - `fullUpper = max(max)` across non-empty rows;
  - `outlierThreshold = max(coreUpper * 1.25, coreUpper + 60, 1)`;
  - if `fullUpper <= outlierThreshold`, use `displayCap = max(fullUpper, 1)`;
  - otherwise use `displayCap = outlierThreshold`.
- Clamp plotted values only for rendering: each row's displayed p25/p50/p75/p90/max is
  `min(rawValue, displayCap)`. Do not mutate the `TimeInStatusBox` values.
- Add `.chartXScale(domain: 0...displayCap)` so Swift Charts does not stretch the axis
  back out to the raw max.
- When `box.max > displayCap`, render the max point at the capped edge and annotate it
  with `max <duration>` using the existing `formatMttmSeconds` formatter, for example
  `max 12h 0m`. When `box.max <= displayCap`, render the max point at its real location
  without the clipped-outlier annotation.
- Expand the row summary for non-empty rows to:
  `median <duration> · p90 <duration> · max <duration>`.
  Keep zero-sample rows as `—`.
- Keep annotations compact and trailing so labels do not cover the status labels or the
  box/whisker marks. If a label would become visually crowded, prefer shortening the
  label text over adding explanatory copy.

## Skills to reference

None.

## Test expectations

Add `ThroughputTimeInStatusDisplayTests.swift` under `AutopodUITests` and test the pure
display helper, not the SwiftUI `Chart` runtime:

- **Outlier cap**: with p90 values in minutes and `max` values in hours, `displayCap` is
  below the raw max, p25/p50/p75/p90 remain unclipped, and max is clamped to the cap with
  `isMaxClipped == true`.
- **No false clipping**: when all max values are within the outlier threshold, `displayCap`
  includes the real max and no row is marked clipped.
- **Zero samples**: rows with `sampleCount == 0` do not influence the cap and remain
  represented as empty rows.
- **All empty**: an all-zero payload yields a safe positive cap and no clipped rows, while
  the view continues to use the existing section-level empty state.

Optional local Mac verification:

```bash
swift test --package-path packages/desktop --filter ThroughputTimeInStatusDisplayTests
```

This command is not an Autopod required fact. It requires a macOS/Xcode-capable host, and
SwiftPM may compile other desktop test targets before it reaches the filtered test.

## Risks / pitfalls

- Swift Charts will use the largest mark value unless all raw `max` values are clamped
  before plotting and the explicit x-domain is applied.
- `formatMttmSeconds` returns `nil` for zero; the helper or row rendering should fall back
  to `"0s"` only for zero-sample placeholders, not for non-empty positive durations.
- Avoid a new explanatory caption. The data labels should explain the outlier without
  adding in-app instructional text.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. If working on a Mac with a healthy desktop SwiftPM test suite, optionally run
   `swift test --package-path packages/desktop --filter ThroughputTimeInStatusDisplayTests`.
3. Report whether Swift verification was run locally or deferred to human review.
