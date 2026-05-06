# Reliability funnel + stage failure analytics

## Problem

The operator (Esben) can see what pods *cost* (Phase 1) but cannot see
*where they break*. Pods can leak at any of 8 lifecycle bands
(`queued → provisioning → running → validating → validated → approved
→ merging → complete`) and any of 8 validation stages (`build`,
`health`, `smoke`, `test`, `lint`, `sast`, `acValidation`,
`taskReview`). Today the only signals are the per-pod detail panel and
the kill/rejected card on Overview — there's no aggregate view of
*which stage is leaking the most pods, on which profile, in the last
30 days*. So when a profile starts misbehaving, it gets noticed only
when individual pods burn cost.

## Outcome

The Overview Analytics page gains a **Reliability** card showing
trailing-30-day first-pass rate, a sparkline of daily first-pass rate,
and a delta vs. the prior window. Clicking the card opens a drill with
four sections: a happy-path funnel (8 bands, with drop-out arrows
showing where pods leaked and the terminal status of leaked pods), a
stage failure ranking (8 stages with pod-fail counts and per-pod
ever-failed rate), a profile × stage failure heatmap, and a summary
callout naming the top failure stage. From the funnel, clicking a drop
expands a top-10 list of the leaked pods.

## Users

Esben, the solo operator. He is the only consumer; metrics are tuned
for "is something off, and where do I go look?" not for stakeholder
reporting.

## Success signal

Open the desktop app on a day with a profile that has a flaky stage,
glance at Overview, click the Reliability card, and within 5 seconds
identify which stage is leaking and which profile is the worst
offender. Validated by Brief 1's API AC: with seeded test data
containing a multi-stage failure, `GET /pods/analytics/reliability`
returns a non-empty `funnel.drops` array AND a non-zero entry in
`stageFailures` for the seeded stage.

## Non-goals

- **No time-series for stage failures.** Sparkline is only for
  first-pass rate. Per-stage daily series would crowd the drill and
  isn't load-bearing for "what's leaking right now."
- **No alerting / Teams notifications.** Read-only dashboard. The
  operator opens the app to look; the system does not push.
- **No new sidebar Reliability sub-row.** The dedicated sidebar
  section stays disabled (matches Phase 1 non-goal pattern). All
  reliability surface is the Overview card + its right-pane drill.
- **No per-attempt drill.** Phase 1 (cost) owns the per-attempt
  taxonomy via `phaseTokenUsage`. Reliability rolls up to per-pod
  ever-failed metrics; if attempt 1 passed `test` but attempt 2
  failed, the pod counts as failed at `test` for stageFailures.
- **No retry of `Cost` work.** The Reliability card consumes Phase 0
  contracts (`AnalyticsCard`, `AnalyticsCardKind`,
  `AnalyticsRightPaneView`) unchanged; `AnalyticsCardKind` gains one
  case (`.reliability`).
- **No new database tables or migrations.** All data is already
  persisted in `events`, `validations`, and `pods.rework_count`.

## Glossary

- **Funnel band** — one of the 8 happy-path PodStatus values pods
  pass through on their way to `complete`:
  `queued | provisioning | running | validating | validated |
  approved | merging | complete`. Other PodStatus values
  (`awaiting_input`, `paused`, `handoff`, `review_required`,
  `merge_pending`, `failed`, `killing`, `killed`) are NOT bands —
  they're side-tracks captured as drop reasons.
- **Drop** — a pair `(from, to)` where pods reached `from` (a band)
  but never reached the next band, instead landing in a terminal
  status (`complete | killed | failed`) or a side-track that ended
  in one of those. `from` is always a band; `to` is the final
  terminal status the pod reached.
- **First-pass** — `pod.status === 'complete'` AND
  `pod.rework_count === 0`. A pod that completed without any
  validation rework is a first-pass success.
- **Stage** — one of the 8 validation phases recorded in the
  `validations.result` JSON: `build`, `health`, `smoke`, `test`,
  `lint`, `sast`, `acValidation`, `taskReview`. Per-pod ever-failed
  semantics: a pod that failed `test` on attempt 1 and passed on
  attempt 2 still counts as "ever-failed test" in `stageFailures`.
- **Terminal cohort** — the set of pods used as the denominator
  everywhere in this endpoint. Defined identically to Phase 1:
  `output_mode != 'workspace'` AND `status IN ('complete',
  'killed', 'failed')` AND `completed_at` falls within the trailing
  N-day window.
