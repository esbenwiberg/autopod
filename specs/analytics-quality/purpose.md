# Analytics — Quality Drill-Down

## Problem

The macOS desktop's Quality story is currently shallow. The Quality card on the
Analytics Overview shows only the trailing-30d average score; the right-pane
`QualityDrillView` is a per-runtime/model summary plus a sortable table
(`AnalyticsView.swift:169-365`). There is no histogram, no "why pods scored
low" breakdown, and no way to filter to a score band. To answer
"show me last week's bottom 20% of pods sorted by cost", the operator drops
out of the app and queries SQLite directly.

Separately, the analytics sidebar carries six sub-rows (Cost, Reliability,
Quality, Safety, Throughput, Models) that duplicate the Overview card grid
with strictly worse affordance — no values, no sparklines, no deltas — and
all of them except Overview render the stale "ships in Phase N" placeholder
even when N has shipped (`MainView.swift:282`). The sub-rows were a Phase 0
placeholder that the card grid has since obsoleted.

## Outcome

Operator can find the bottom 20% of last week's pods sorted by cost in fewer
than three clicks from the desktop UI; the Analytics sidebar is a single
row and the placeholder text is gone.

## Users

Esben, operating his own pod fleet. Operator-grade — not audit-grade. Makes
model-mix and profile-tuning decisions based on what is killing pod quality.

## Success signal

`GET /pods/analytics/quality?days=30` returns a composite payload
(`summary`, `sparkline`, `distribution`, `reasons`, `scores`). The
operator opens Analytics → Overview → clicks the Quality card → clicks the
**Red** band chip → sorts the table by Cost ascending — the bottom-20%
appears with their reason signals visible. Validated by Brief 02's `api`
ACs and anchored on the desktop side by Test expectations + diff review.

## Non-goals

- **No new Quality detail tab.** Row-click focuses the existing Summary tab
  (where `SessionQualityCard` lives at `SummaryTab.swift:39`); `DetailTab`
  enum is unchanged.
- **No backfill of historical scores.** Forward-only — same cross-cutting
  rule as Phases 1+2.
- **No Safety / Throughput / Models card or sub-row activation.** Those are
  Phases 4–6 in the master plan; this spec deliberately deletes their
  sidebar surface.
- **No PDF / CSV export of the quality table.**
- **No min/max score sliders.** Filter UX is band chips only — All / Red / Yellow /
  Green. Sliders are noisy for an operator-grade fleet.
- **No retention of the Cost/Reliability/Quality/etc. sub-rows in the
  sidebar.** They are deleted with the rest of `AnalyticsSection`'s
  non-Overview cases.
- **No new migration.** All seven reason signals are already on
  `pod_quality_scores` (migrations 055 + 057).
- **No changes to the existing `/pods/scores` or `/pods/quality/trends`
  endpoints.** The new composite endpoint stands alongside them.

## Glossary

- **Score band** — Red (<60), Yellow (60–79), Green (80+). Same thresholds
  as `analyticsScoreColor` (`AnalyticsView.swift:504`). Band chips on the
  drill view filter table + reason counts to one band.
- **Reason** — One of the seven persisted low-quality signals on
  `pod_quality_scores`: low read/edit ratio (<1), edits without prior read
  (>0), user interrupts (>0), validation failed (`validation_passed = 0`),
  PR fix attempts (>0), edit churn count (>0), tells/negative-language
  count (>0). Computed by `quality-signals.ts:computeQualitySignals`,
  persisted on completion by `quality-score-recorder.ts:38`.
- **Quality drill view** — The right-pane content rendered when the Quality
  card is clicked on Overview. Replaces the existing inline
  `QualityDrillView` struct in `AnalyticsView.swift:169-365`.
- **Trailing window** — `datetime('now', '-' || @days || ' days')` —
  Phase 1 precedent in `quality-score-repository.ts:167`.
- **Composite endpoint** — One HTTP call returns everything the drill
  needs, matching the Cost / Reliability shape from
  `pods.ts:238`/`pods.ts:252`. No fan-out into per-section endpoints.
