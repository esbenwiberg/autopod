# Analytics Throughput

## Problem
The macOS analytics dashboard answers "where does my money go?", "where do
pods leak through the state machine?", "what does pod quality look like?"
and "are guardrails firing?" — but it has no view of operational rhythm.
The operator can't see when the fleet is busy (hour-of-day / day-of-week
patterns), how throughput trends over time, or whether the queue is
healthy. Capacity questions ("did I hit a Tuesday-afternoon backlog
again?", "is MTTM creeping up week-over-week?") require opening the DB.

## Outcome
A new Throughput card on the analytics dashboard surfaces mean
pods-per-day with a daily-volume sparkline; clicking it opens a drill
with three sections — an hour-of-day × day-of-week heatmap (cells
expand to a list of completed pods, each clickable through to the pod
detail), an hourly queue-depth time-series (max line + mean shaded
area), and a time-in-status box plot for the four load-bearing states
(queued, running, validating, awaiting_input).

## Users
Esben (operator) — tuning his own pod fleet. Operator-grade, not
audit-grade. The drill answers "how busy is the fleet, when, and how
fast does work move through it?", not "can I attest to a regulator?".
Locked by the master plan
(`docs/analytics-dashboard-plan.md` Audience section).

## Success signal
The operator can show another human, in three clicks from the analytics
dashboard: "busiest day-of-week pattern is Tuesday afternoons; queue
peaked at N pods on Day-X; running median is Yh." The endpoint that
materialises this is Brief 01's
`GET /pods/analytics/throughput?days=30`, which returns `summary`,
`cohort`, `queueDepth`, `timeInStatus` in one composite payload —
verified by AC #1 in Brief 01. The user-visible drill is delivered by
Brief 02 with zero ACs by the established desktop-brief precedent
(native macOS profile has no web UI for `web` ACs to fire against);
verification there is via Test expectations on the Codable mirror plus
the diff reviewer.

## Non-goals
- **Escalations card and drill.** Phase 5 in the master plan bundled
  Throughput + Escalations; these spec runs split them. Escalations
  ships in a separate `analytics-escalations` spec (Phase 5b).
- **Profile filter on the drill.** Phase 2's reliability funnel exposes
  `?profile=`; Throughput v1 does not. Easy to add later when the operator
  asks for it; not in this scope.
- **"Open as workspace" CTA.** Master-plan principle is aspirational;
  prior drills (Cost / Reliability / Quality / Safety) ship without it.
  Stay consistent.
- **Real-time updates.** The card refetches on view-mount and on
  days-picker change; no WebSocket subscription. Backlog count is
  point-in-time at request time.
- **Per-runner / per-machine throughput stats.** The distributed-runner
  feature exists (ADR-001 to ADR-006) but per-runner attribution is out
  of scope here.
- **Pagination of the cohort payload.** Up to ~thousands of pod records
  for a 90-day window is acceptable; revisit if window grows.
- **Backfill of historical metrics.** Same forward-only convention as
  every prior phase — pre-event-bus pods get zero samples in
  time-in-status; the design.md spells this out.
- **Mobile / web analytics surfaces.** macOS only.

## Glossary
- **Pods/day (headline)** — mean pods-per-day across the trailing
  window: `|terminal cohort| / days`. Formatted as a one-decimal float
  on the card.
- **Sparkline** — daily-completed pod count, one entry per day in the
  window, length always equal to `days`.
- **MTTM (mean time to merge)** — mean of `(completed_at - created_at)`
  in seconds, restricted to pods with `status='complete'` in the
  terminal cohort. Includes queue wait time — reflects user-perceived
  request-to-merged-PR latency. Killed/failed pods are excluded.
- **Backlog** — live point-in-time count of pods with
  `status IN ('queued','provisioning')`. Independent of the trailing
  window.
- **Terminal cohort** — Phase 1's locked predicate, applied to most
  sections: `output_mode != 'workspace' AND status IN
  ('complete','killed','failed') AND completed_at >= datetime('now',
  '-' || @days || ' days')`. Bucketed by `completed_at` for sparkline
  and heatmap.
- **Queue-intersect cohort** — distinct from terminal cohort. Used
  *only* for the queue-depth time-series. A pod contributes to depth
  during the half-open interval `[created_at, started_at)` (or
  `[created_at, now)` for pods that never started). Cohort = any pod
  whose interval intersects `[window_start, window_end]` —
  including in-flight pods that haven't completed yet.
- **Heatmap cell** — one of 24 × 7 = 168 buckets keyed by
  `(localHourOfDay, localDayOfWeek)`. Bucketed client-side from raw
  ISO `completed_at` timestamps in the user's local timezone.
- **Time-in-status box plot** — for each of {queued, running,
  validating, awaiting_input}: p25, p50, p75 (the box), p90 (whisker
  end), and max (marker). Per-pod durations derived from consecutive
  `pod.status_changed` events on the `events` table.
- **Load-bearing states** — the four states pods spend meaningful
  time in. Other PodStatus values (`provisioning`, `validated`,
  `approved`, `merging`, `complete`, `paused`, `handoff`,
  `review_required`, `merge_pending`, `failed`, `killing`, `killed`,
  `rejected`) are excluded from the box plot — they are transitional
  and would render as near-zero noise.
