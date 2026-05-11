# Analytics Models

## Problem
The macOS analytics dashboard now answers cost, reliability,
quality, safety, throughput, and escalation questions — but it
gives no view of **which model the operator should actually be
running**. Model-mix decisions today are vibes-driven: "I think
Sonnet handles the simple stuff fine"; "Opus feels worth it on the
hard tickets". The operator has no way to look at the trailing
window and see, by model, what $/PR they're actually paying, what
quality they're getting, where pods are failing, and — most
importantly — what would happen if they redirected a slice of one
model's pods to another. Today they'd have to join `pods` against
`pod_quality_scores` by hand, normalise model strings across the
`opus` vs `claude-opus-4-7` alias collision, and compute a
counterfactual with a calculator.

## Outcome
A new **Models card** on the analytics dashboard surfaces the
**cheapest $/PR model name** as the headline value with a daily
pod-count sparkline of the most-used model; clicking it opens a
drill with four sections — a per-model **leaderboard table**
(model · pods · success rate · $/PR · avg quality · mean
time-to-merge · escalation rate), a side-by-side **comparison
panel** rendering the same axes in chart form, a per-model
**failure-stage breakdown matrix** (model rows × 8
ValidationStage columns), and a client-side **what-if simulator**
that lets the operator pick a source model, a target model, and a
0–100% redirect slider and projects the new fleet aggregates on
all five comparison axes using weighted averages of historical
per-model means. A drill-level toggle re-rolls the table and
comparison by **runtime** (claude / codex / copilot) instead of by
model.

## Users
Esben (operator) — tuning his own pod fleet. Operator-grade, not
audit-grade. The drill answers "which model is actually winning,
where do they fail differently, and what happens if I redirect a
chunk of pods between them?". Locked by the master plan
(`docs/analytics-dashboard-plan.md` Audience section).

## Success signal
The operator can show another human, in three clicks from the
analytics dashboard: "Haiku is the cheapest at $X/PR over the last
30 days; Opus is the highest quality at Yavg; if I move 30% of my
web-stack profile pods from Opus to Sonnet the simulator projects
$Z/PR and a Wpp drop in success rate." The endpoint that
materialises this is Brief 01's `GET
/pods/analytics/models?days=30`, which returns `summary`,
`byModel`, `byRuntime`, `failureStageMatrix`, and `unknownModels`
in one composite payload — verified by AC #1 in Brief 01. The
user-visible drill is delivered by Brief 02 (leaderboard +
comparison + failure-stage matrix) and Brief 03 (simulator), both
shipping with zero ACs by the established desktop-brief precedent
(native macOS profile has no web UI for `web` ACs to fire
against); verification there is via Test expectations on the
Codable mirror plus the diff reviewer.

## Non-goals
- **`POST /pods/analytics/simulate` server endpoint.** Master plan
  flagged this as optional and "could also be done client-side;
  defer the call." Brief 03 runs the simulator entirely in Swift
  off the aggregates Brief 01 already returns — no new endpoint,
  no DB hit per slider move.
- **Per-profile redirect rules.** The simulator is **one global
  redirect rule**: source model + target model + percentage. Not
  per-profile, not multi-rule. Adding profile dimensions
  multiplies the UX 10×; if the operator wants per-profile, they
  filter the underlying cohort first (out of scope here) or
  defer to a follow-up.
- **`request_credential` and `ask_ai` in the escalation rate.**
  Mirrors phase 5b's locked `HumanAttentionKind` scope
  (`ask_human + report_blocker + validation_override +
  action_approval`). The escalation rate axis here uses the same
  predicate verbatim.
- **Per-pod cost breakdown.** The Cost card (phase 1) owns the
  per-pod cost drill-down. The Models card aggregates across
  pods; it doesn't drill into individual cost rows.
- **Free-form model picker.** The leaderboard surfaces whatever
  models appear in the trailing-window cohort. Unknown / unpriced
  model strings appear under `unknownModels` (separate list,
  excluded from cost-derived axes but included in volume-derived
  axes) and don't pollute the simulator dropdowns.
- **Backfill of historical metrics.** Same forward-only
  convention as every prior phase — pods + pod_quality_scores +
  escalations + validations have all existed for many migrations
  so this is largely moot, but the design.md spells out the
  cohort-pinning behaviour anyway.
- **Web / mobile analytics surfaces.** macOS only.
- **Real-time updates.** The card refetches on view-mount and on
  days-picker change; the simulator recomputes locally on every
  slider tick. No WebSocket subscription.

## Glossary

- **Model (analytics grain)** — the canonical model identifier
  after running `pods.model` through `MODEL_CANONICAL` (see
  ADR-022). Examples: `claude-opus-4-7`, `claude-sonnet-4-6`,
  `claude-haiku-4-5`, `gpt-5`, `gpt-5-mini`. Short aliases (`opus`
  / `sonnet` / `haiku`) coalesce into their full IDs so the
  leaderboard never shows two rows for what is the same model.
- **Runtime** — `claude` / `codex` / `copilot` (the
  `RuntimeType` union in `packages/shared/src/types/runtime.ts`).
  Surfaced as a drill-level toggle that re-rolls the same
  aggregates by runtime instead of model.
- **Unknown model** — any `pods.model` string that does not match
  a key in `MODEL_PRICING` and does not coalesce via
  `MODEL_CANONICAL`. Surfaced as a count + sample-list in
  `unknownModels`. Excluded from `$/PR` and any other
  cost-derived axis (we can't price it); included in volume,
  success rate, quality, mean TTM, and escalation rate.
- **Terminal cohort** — phase 1's locked predicate, reused
  verbatim: `output_mode != 'workspace' AND status IN
  ('complete','killed','failed') AND completed_at >= datetime('now',
  '-' || @days || ' days')`. Denominator for every per-model
  aggregate.
- **Cheapest $/PR (headline)** — the canonical-model name with the
  lowest `$/PR` value across `byModel[]` rows where
  `completeCount >= MIN_COHORT_FOR_HEADLINE` (5). When the cohort
  has nothing eligible, the headline value is `—`.
- **$/PR (per model)** — `SUM(effectiveCostUsd(pod))` across all
  terminal-cohort pods on this model, divided by
  `COUNT(pods on this model WHERE status = 'complete')`. Waste is
  included in the numerator (a killed pod still cost real money).
  When `completeCount === 0` for a model, `$/PR` is `null` (don't
  divide by zero; the desktop renders `"—"`).
- **Avg quality (per model)** — mean of
  `pod_quality_scores.score` for terminal-cohort pods on this
  model with a quality row. Pods without a quality row are
  excluded from the numerator AND denominator (small-N is the
  honest read; the leaderboard surfaces `scoredCount` separately
  so the operator sees how thin the signal is).
- **Success rate (per model)** — `completeCount / podCount` for
  terminal-cohort pods on this model. Pods with `status='killed'`
  or `status='failed'` count in the denominator but not the
  numerator. In [0, 1].
- **Mean TTM (per model)** — mean of
  `(julianday(completed_at) - julianday(created_at)) * 86400`
  seconds, over terminal-cohort pods on this model with
  `status='complete'`. Mean (not median) for cross-phase
  consistency with `throughput-aggregator.ts:238` and so the
  client-side simulator can weighted-average it cleanly. Null
  when `completeCount === 0`.
- **Escalation rate (per model)** — distinct count of
  terminal-cohort pods on this model with at least one
  human-attention escalation
  (`type IN ('ask_human','report_blocker','validation_override','action_approval')`),
  divided by `podCount`. Identical predicate to phase 5b. In
  [0, 1].
- **Failure-stage breakdown** — a matrix of canonical model rows
  × 8 `ValidationStage` columns (`build, health, smoke, test,
  lint, sast, acValidation, taskReview`). Each cell is
  `{ podsRan, podsFailed, failureRate }`, mirroring the
  Reliability aggregator's `profileHeatmap` shape verbatim. Source
  data: `validations` rows for terminal-cohort pods.
- **MIN_COHORT_FOR_HEADLINE** — `5`. Models with fewer than 5
  terminal-cohort pods are excluded from the cheapest-$/PR
  headline determination AND the "winner per axis" subline
  computation; they still appear in the leaderboard table (just
  visually de-emphasised with a small-N caption). Mirrors phase
  5b's per-profile fold-in threshold.
- **What-if simulator (Brief 03)** — three controls: a source-model
  dropdown, a target-model dropdown, and a 0–100% redirect
  percentage slider. Output: projected fleet aggregates on all 5
  comparison axes (cost-per-PR, quality, success rate, mean TTM,
  escalation rate), computed client-side as weighted averages of
  the historical per-model aggregates Brief 01 returns. The
  projection is **naïve** by design: it assumes future pods on
  the target model will perform identically to the past
  terminal-cohort pods on the target model. UI must flag this
  assumption (see ADR-023 and the Brief 03 constraints).
