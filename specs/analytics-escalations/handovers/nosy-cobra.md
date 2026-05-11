# Handover: analytics-escalations Brief 02 (nosy-cobra)

## What was built

Surfaced the Escalations analytics card on the dashboard and the three-section drill view. All data consumed verbatim from the daemon endpoint shipped in Brief 01.

**Files added:**
- `packages/desktop/Sources/AutopodClient/Types/EscalationsAnalyticsResponse.swift` —
  Codable mirror: `EscalationsAnalyticsResponse`, `EscalationsSummary`, `EscalationsSparklinePoint`,
  `EscalationsRateDelta`, `AskHumanTtr`, `AskHumanTtrBucket`, `PerProfileEscalation`, `BlockerPattern`.
  Plain `JSONDecoder()` (no key strategy); daemon emits camelCase.
- `packages/desktop/Tests/AutopodClientTests/EscalationsAnalyticsResponseTests.swift` —
  6 tests: happy-path round-trip, minimal payload, camelCase decoder strategy, direction enum all-cases,
  bucket label byte-for-byte (en-dash U+2013), synthetic `<small profiles>` row.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/EscalationsDrillView.swift` —
  Three-section drill: (1) `ask_human` TTR bar chart with 8 buckets + resolved/open header + max footer,
  (2) per-profile table with `<small profiles>` static caption, (3) blocker patterns `DisclosureGroup`
  with pod-id chips + overflow indicator. Sticky days picker (7/14/30/60/90, default 30). Error banner.

**Files modified:**
- `packages/desktop/Sources/AutopodClient/DaemonAPI.swift` — added `getEscalationsAnalytics(days:)`.
- `packages/desktop/Sources/AutopodUI/Models/AnalyticsCardKind.swift` — added `.escalations`.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsRightPaneView.swift` — added
  `loadEscalations` + `onEscalationsSelectPod` parameters; `.escalations` switch case.
- `packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift` — escalations card state,
  computed properties (value/"—" when cohortSize==0, sparkline, delta, sub-line), card in grid,
  task fetch, `AnalyticsCardDelta.Direction` init for `EscalationsRateDelta.Direction`.
- `packages/desktop/Sources/AutopodUI/Views/Shell/MainView.swift` — `loadEscalationsAnalytics`
  property + init + wiring into both AnalyticsView and AnalyticsRightPaneView call sites.

## Key invariants downstream pods must honour

- `AnalyticsCardKind` now has 7 cases: `cost, quality, status, reliability, safety, throughput, escalations`.
  Any new exhaustive switch on this enum must handle `.escalations`.
- `AnalyticsRightPaneView.init` has two new optional parameters at the end:
  `loadEscalations: ((Int) async throws -> EscalationsAnalyticsResponse)? = nil` and
  `onEscalationsSelectPod: ((String) -> Void)? = nil`. No call sites break (both default to nil).
- `AnalyticsView.init` has one new optional parameter:
  `loadEscalationsAnalytics: ((Int) async throws -> EscalationsAnalyticsResponse)? = nil`.
- `MainView.init` has one new optional parameter:
  `loadEscalationsAnalytics: ((Int) async throws -> EscalationsAnalyticsResponse)? = nil`.

## Files I own that the next pod should NOT modify without good reason

- `EscalationsAnalyticsResponse.swift` — contract is locked to Brief 01's TS source; any schema change
  must start from `packages/shared/src/types/analytics.ts`.
- `EscalationsDrillView.swift` — section order, header/footer spec, and DisclosureGroup expansion
  semantics are all per the design.md contract.

## AppRootView.swift not updated

`packages/desktop/Sources/AutopodDesktop/Views/AppRootView.swift` was NOT updated to pass
`loadEscalationsAnalytics` to `MainView`. This is consistent with how the prior phases (safety,
throughput) were handled: those closures are also absent from AppRootView. In production the card
shows "—" without the daemon closure, which is acceptable pending a separate wiring pass.

## Discovered constraints / landmines

- **`EscalationsTtrSectionView` nil guard is intentional**: the section is inside the parent's
  `else` block (`!(isLoading && response == nil)`), so `ttr` is never nil when the section renders.
  The section-level nil-ProgressView was removed during simplify.
- **`escalationsLoadError` intentionally absent**: error state is swallowed (card shows "—") consistent
  with safety/throughput cards. Unlike the quality card, there is no "Error" fallback string.
- **`perProfile ?? []` is unreachable dead code**: the empty-state copy will never show while loading.
  Harmless defensive code left in place.
- **En-dash in bucket labels**: the 8 fixed labels use U+2013 (`–`), not hyphen-minus. Tests verify
  this byte-for-byte via the hoisted `_escalationBucketLabels` constant.
