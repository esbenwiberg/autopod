# Analytics Shell

## Problem
The current `AnalyticsView` (`packages/desktop/Sources/AutopodUI/Views/Analytics/AnalyticsView.swift`) is a single stacked `ScrollView` rendering hero stats, secondary stats, a status proportion bar, a per-profile breakdown, and the session quality table all on one page. There is no routing chassis for breaking the view apart, no card grid for at-a-glance summaries, and the right pane (currently bound to fleet selection) plays no role in analytics. `docs/analytics-dashboard-plan.md` adds six future sections (Cost, Reliability, Quality, Safety, Throughput, Models) and a card-click drill-in pattern; without scaffolding, every later phase will re-litigate the same architectural decisions.

## Outcome
The macOS desktop app gains an analytics shell: nested sidebar sub-rows under Analytics (Overview wired, six others visible-but-disabled), a card-grid Overview screen with three migrated cards (Cost, Quality, Status), and a right-pane drill-in scene state that renders the existing deeper sections of `AnalyticsView` when a card is clicked. Clicking the same card toggles the right pane back to its empty state. Selection persists across fleet ↔ analytics navigation.

## Users
Esben (solo operator) — the sole user of the desktop app. The shell is for him; this is not an audit-grade or multi-user surface.

## Success signal
Manual verification (no automated AC available — see Non-goals):

- Sidebar shows seven sub-rows under Analytics. Only Overview is clickable; the other six are visibly disabled and non-interactive.
- Clicking Overview shows three cards (Cost, Quality, Status) in the middle pane. Today's secondary stats (pod count, success rate, lines added, input/output tokens) are deliberately not shown — they re-appear in later phases.
- Clicking a card fills the right pane with the corresponding existing deeper section: Cost → per-profile breakdown rows; Quality → runtime/model summary cards + sortable scores table; Status → expanded proportion bar with row-style legend.
- Clicking the same card again clears the right pane back to "Click a card to drill in".
- Switching the sidebar to Attention/Active/etc. and back to Overview preserves the previously selected card.

## Non-goals
- No new daemon endpoints. No new aggregations. No new SQL or migrations.
- No sparkline data. The `AnalyticsCard` component exposes the slot, but Phase 0 leaves it `nil` for all three cards.
- No delta-vs-prior-period calculation.
- **No automated acceptance criteria.** The standard validation pipeline (`pnpm build`, `pnpm test`, `validate.sh`) does not invoke `swift build` / `xcodebuild`, and validation containers are Linux + cannot build the macOS-only targets in `Package.swift`. Anchoring is via Test expectations + diff reviewer + manual user verification.
- No content or UX changes outside the Analytics tab.
- No new ADRs. No hard-to-reverse decisions in this phase.
- HistoryView, FeatureOverview, ScheduledJobs, and pod-detail surfaces are out of scope.

## Glossary
- **Section** — a sub-route under Analytics in the sidebar. Modeled by the `AnalyticsSection` enum: `.overview`, `.cost`, `.reliability`, `.quality`, `.safety`, `.throughput`, `.models`. Phase 0 wires only `.overview`.
- **Card** — a clickable summary tile in the middle-pane card grid. New `AnalyticsCard` SwiftUI view. Slots for title, value, optional sparkline (nil in Phase 0), optional delta (nil in Phase 0), `isSelected`, and an `onClick` callback.
- **Drill-in** — the right-pane content rendered when a card is clicked. Phase 0 reuses existing `AnalyticsView` deeper sections (`profileBreakdown`, `qualitySection`, `statusProportionBar`) as drill content.
- **Overview** — the only wired section in Phase 0. Renders three Cards in the middle pane.
- **AnalyticsCardKind** — the clicked-card discriminator enum (`.cost`, `.quality`, `.status`). Held as `@State` in `MainView` and consumed by `AnalyticsRightPaneView`.
