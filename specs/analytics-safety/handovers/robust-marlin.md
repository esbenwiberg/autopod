# Handover — robust-marlin (Brief 06: Desktop Safety Card + Drill View)

## What was built

Eight Swift files changed or created to surface the Safety analytics card and five-section drill in the macOS desktop app.

### New files

- **`packages/desktop/Sources/AutopodClient/Types/SafetyAnalyticsResponse.swift`**
  Codable structs mirroring the TS contract verbatim:
  `SafetyAnalyticsResponse`, `SafetyAnalyticsSummary`, `SafetyKindCounts`,
  `SafetySparklinePoint`, `SafetyDelta`, `SafetyEventKind`, `SafetyPatternCount`,
  `SafetyEventSource`, `SafetySourceCount`, `SafetyHistogramBucket`, `SafetyPodEntry`,
  `SafetyInjectionEntry`, `NetworkPolicyBucket`, `SafetyNetworkPolicyCount`,
  `SafetyAuditChainStatus`, `SafetyAuditMismatch`, `AuditChainVerifyResponse`.
  All public, `Decodable & Equatable & Sendable`.

- **`packages/desktop/Tests/AutopodClientTests/SafetyAnalyticsResponseTests.swift`**
  JSON round-trip tests covering: full populated payload, auditChain all-null shape,
  `__pre_creation__` pod with `profile == nil`, all three delta directions, both
  `SafetyEventKind` cases, all four `NetworkPolicyBucket` cases, all seven
  `SafetyEventSource` cases, `AuditChainVerifyResponse` with and without mismatch,
  and `SafetyInjectionEntry` with `severity == nil` (PII rows).

- **`packages/desktop/Sources/AutopodUI/Views/Analytics/SafetyDrillView.swift`**
  Five-section drill following the locked order from design.md:
  1. PII histogram by pattern (horizontal `BarMark`, sorted by count DESC)
  2. Quarantine score histogram (10 buckets, color ramp neutral→red at 0.7+)
  3. Injection attempts table (When / Pattern / Severity / Pod; `__pre_creation__` rows non-clickable, muted)
  4. Audit-chain integrity widget (`valid: true/false/nil` states; "Verify now" button with loading state; re-fetches safety on success)
  5. Network-policy distribution (4 counters: allow-all / restricted / deny-all / unknown)
  
  Header: sticky days picker (7 / 14 / 30 / 60 / 90, default 30). Re-fetches on change via `.task(id: days)`. Per-section empty states and `ProgressView` skeletons. `SafetyInlineErrorBanner` error banner.

### Modified files

- **`DaemonAPI.swift`** — `getSafetyAnalytics(days:)` + `verifyAuditChain()` added alongside existing analytics methods.
- **`AnalyticsCardKind.swift`** — `.safety` case added; the only exhaustive switch on this enum is in `AnalyticsRightPaneView.swift` (handled there).
- **`AnalyticsRightPaneView.swift`** — `.safety` case routes to `SafetyDrillView`. New properties `loadSafety`, `verifyAuditChain`, `onSafetySelectPod` added (all optional, backward-compatible).
- **`AnalyticsView.swift`** — Safety card added to grid with `value`, `sparkline`, `delta`, `subline`. Sub-line `"\(pii) PII · \(quar) quar · \(inj) inj"` suppressed when `totalEvents == 0 && quarantineCount == 0`. Delta formatted as `String(format: "%+d", value)`. `AnalyticsCardDelta.Direction` extension added for `SafetyDelta.Direction`. `loadSafetyAnalytics` closure fetches with hardcoded 30d (same convention as other overview cards). Safety task runs concurrently with other fetch tasks.
- **`MainView.swift`** — `loadSafetyAnalytics: ((Int) async throws -> SafetyAnalyticsResponse)?` and `verifyAuditChain: (() async throws -> AuditChainVerifyResponse)?` properties + init params added. Both threaded into `AnalyticsView` and `AnalyticsRightPaneView`. `onSafetySelectPod` sets `requestedDetailTab = .summary` matching Quality precedent.

## Deviations from brief

Two intentional deviations:

- **Injection table: Source column dropped**
  The brief specifies `When / Source / Pattern / Severity / Pod`. However, `SafetyInjectionEntry` in the TS contract (`topInjections` inside `byPod`) does not include a `source` field — only `patternName`, `severity`, `payloadExcerpt`, and `createdAt`. Populating Source from `r.bySource.first` (global aggregation) would show misleading data. The column was dropped; the table renders `When / Pattern / Severity / Pod`. If Brief 05 can add `source` to `topInjections` in a future iteration, the Swift type and table column can be added back with a one-line change.

- **Phase 0 sidebar sub-row: not flipped (precondition unmet)**
  The brief instructs to flip the disabled flag on a Safety sub-row in the sidebar, citing `specs/analytics-shell/design.md`. That design defines an `AnalyticsSection` enum and replaces `SidebarItem.analytics` with `SidebarItem.analyticsSection(AnalyticsSection)` rendering nested rows with `.disabled(!section.isShipped)`. **That refactor was never implemented in this codebase**: there is no `AnalyticsSection.swift`, no `analyticsSection` case on `SidebarItem`, and `SidebarView.swift` currently renders only a single flat `.analytics` row (no Safety sub-row exists, disabled or otherwise). `rg 'AnalyticsSection|analyticsSection|isShipped' packages/desktop/Sources/` returns zero matches.
  Implementing the Phase 0 nesting from scratch would: introduce a new enum, change the `SidebarItem` shape (a `Hashable` used as a binding throughout `MainView`), update every exhaustive switch on `SidebarItem`, and add label/icon/isShipped wiring — well beyond Brief 06's remit and outside its declared `touches` block. No flag was flipped because no flag exists; the prerequisite Phase 0 work belongs to a separate brief in the analytics-shell spec. The single flat `.analytics` row already routes into the AnalyticsView Overview, where the Safety card is now visible — so the user-facing functionality of "navigate to safety" is reachable via the existing analytics entry point.

## Files owned — do not modify without good reason

- `SafetyAnalyticsResponse.swift` — cross-pod contract; renaming any field breaks JSON decoding silently
- `SafetyAnalyticsResponseTests.swift` — Codable correctness guard
- `SafetyDrillView.swift` — drill layout (section order is locked per design.md)

## Contract notes for any future desktop pods

- `SafetyAuditChainStatus.valid` is `Bool?` — three-state rendering is required; don't collapse to `Bool`.
- `SafetyPodEntry.podId` is `String` not `String?` — `"__pre_creation__"` is a real string value, not nil. The table checks `podId == "__pre_creation__"` to suppress row-click.
- `NetworkPolicyBucket.allowAll` decodes from `"allow-all"` (raw value with hyphen), not `"allowAll"`.
- `SafetyEventSource.actionResponse` decodes from `"action_response"` (snake_case), not `"actionResponse"`.
- `AuditChainVerifyResponse` is used only by `verifyAuditChain()` → the result is discarded after triggering a safety re-fetch. Do not persist it in view state.

## Discovered constraints

- `InlineErrorBanner` in `ReliabilityDrillView.swift` is `private` to that file. `SafetyDrillView` defines its own `SafetyInlineErrorBanner` with identical layout. A future refactor could lift this to a shared `AnalyticsInlineErrorBanner` in `AnalyticsView.swift`, but that would require touching `ReliabilityDrillView.swift` (not in this brief's scope).
- The pre-submit reviewer timed out (CLI timeout at 90s). All TS tests pass (2377/2377); Swift types were manually verified against the TS contract.
