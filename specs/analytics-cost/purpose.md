# Analytics Cost (Phase 1)

## Problem

The Cost card on the Analytics Overview (shipped in Phase 0) shows a
single number computed client-side from whatever pods are in memory:
`sum(pod.costUsd)` minus running/paused. Today that number is wrong in
two ways. First, only Claude pods populate `pod.costUsd` — Codex and
Copilot pods carry token counts but contribute $0 to the total because
nothing in the daemon knows what their tokens are worth. Second, even
for Claude pods, the *cost* is opaque: there is no way to see how much
of a $30 PR went into the agent's first attempt vs three rework cycles
vs the AI task review. `pods.phase_token_usage` (migration `089`) only
captures `review` and `plan_eval` token counts; the agent's own work is
one big bucket. The "where does my money go?" question — the operator's
single most important cost question — has no answer surface today.

## Outcome

The Cost card on Overview shows a real 30-day total with sparkline and
delta vs the prior 30 days; clicking it opens a drill-in showing a
per-attempt stacked bar (agent initial vs reworks vs review vs
plan eval), a profile × model breakdown, the top-10 most expensive
pods, and a strict-waste callout (`$` spent on `killed`/`failed`/
`rejected` pods).

## Users

Esben (solo operator). Same audience as Phase 0; the dashboard is for
tuning his own pod fleet, not for auditors or stakeholders.

## Success signal

`GET /pods/analytics/cost?days=30` returns 200 with the full composite
shape (`total`, `sparkline[]`, `deltaVsPrior`, `byPhase[]`,
`byProfileModel[]`, `top10[]`, `waste{}`) — anchored by Brief 03's
`api` ACs. Manually: opening the Cost card on a non-empty database
shows non-zero numbers for Claude *and* non-Claude pods (proving the
pricing module works), the drill renders all four sub-views, and
clicking a top-10 row navigates to that pod's detail view.

## Non-goals

- **No backfill.** Pods that completed before Phase 1 ships will not
  retroactively have per-attempt token data. The aggregator surfaces
  pre-instrumentation pods under a synthetic `agent_legacy` bucket so
  totals still reconcile, but no historical re-attribution.
- **No auto-pricing fetch.** Pricing is a hand-edited JSON file
  (ADR-015). When a vendor changes prices, edit the JSON and redeploy.
- **No ad-hoc date ranges.** Only trailing windows (`?days=N`). The
  date picker UX and `from/to` query params are deferred.
- **No fix-pod-to-parent rollup.** Fix pods (linked via `fixPodId`)
  appear as standalone rows in top-10 even though they cost money on
  behalf of a parent PR. Aggregation across the chain is a future
  refinement.
- **No `$/merged-PR` metric.** The plan doc lists this, but it couples
  cost to PR state and feels noisy when a PR is mid-merge. Deferred
  until the Reliability phase, which already touches PR state.
- **No price-change history / audit trail.** The pricing JSON has no
  versioning. If you need "what did we pay last month at the old price",
  recompute by checking out the old JSON.
- **No fleet-level export** (CSV / JSON download). Operator-grade UI
  only.
- **No new shipped sidebar sub-row.** Phase 0 sidebar has Cost as
  `.disabled(true)`; that stays disabled. Phase 1 fills out only the
  Overview Cost *card* and its right-pane drill — it does not unlock
  the dedicated Cost section, which is reserved for a future phase that
  adds standalone deeper analytics.

## Glossary

- **Phase** — a token-usage bucket on `pods.phase_token_usage`. After
  Phase 1: `agent_initial`, `agent_rework_<N>` (one per validation-loop
  retry; N starts at 1), `review` (existing — AI task review), and
  `plan_eval` (existing — plan evaluation). Plus a synthetic
  `agent_legacy` reconstructed at aggregation time for pods completed
  pre-Phase-1. See ADR-016.
- **Effective cost** — `pod.costUsd` if it's > 0 (Claude pods);
  otherwise `inputTokens × pricing[model].inputPer1M / 1e6 +
  outputTokens × pricing[model].outputPer1M / 1e6`. Computed at
  aggregation time, never stored.
- **Waste** (strict) — sum of effective cost across pods whose final
  status is `killed`, `failed`, or `rejected`. Excludes `complete`
  pods entirely, even ones that ran multiple rework cycles. Reworks
  on completed pods are visible in the per-attempt bar instead.
- **Trailing window** — the last N days from now (`now() - N days` ≤
  `pod.completedAt` ≤ `now()`). Default `N = 30`. The "prior period"
  for delta calculation is the immediately preceding window of the
  same length.
- **Pricing config** — the JSON catalog at
  `packages/shared/src/pricing/model-pricing.json` (USD per 1M tokens,
  per model ID). Source of truth for non-Claude cost; also the
  fallback for Claude pods missing `costUsd`. See ADR-015.
- **Sparkline** — 30 daily totals, one per day in the trailing window.
  Each is the sum of effective cost across terminal worker pods that
  completed that day. Days with no pods are `0` (not omitted) so the
  sparkline length always equals `days`.

## Reversibility

Phase 1 is largely additive (new endpoint, new files, new bucket keys)
but it does change a writer path in `pod-manager.ts` that all completed
pods flow through. Rollback strategy:

- The pricing JSON, the cost endpoint, and the desktop drill UI are
  pure additions and can be reverted via `git revert` with no data
  consequences.
- The `pod-manager.ts` per-attempt instrumentation is also additive —
  it writes new keys to a JSON column that's already nullable. Reverting
  it stops new writes; existing writes remain in the DB and are simply
  ignored when nothing reads them. No migration to roll back.
- The `phase_token_usage` shape extension in `@autopod/shared` is a
  type widening (new optional keys); reverting it does not break any
  caller that didn't read those keys yet.

The hard-to-reverse decisions are captured in ADR-015 (pricing source
of truth) and ADR-016 (phase taxonomy). Both are documented separately
so that any future supersession is explicit.
