# Analytics Escalations

## Problem
The macOS analytics dashboard now answers "where does my money go?",
"where do pods leak through the state machine?", "what does pod quality
look like?", "are guardrails firing?", and (after Phase 5a) "how busy is
the fleet and how fast does work move through it?" — but it has no view
of escalations. The operator can't see how often pods stop and ask for
help, what fraction of those asks need a human (vs another AI the agent
can self-resolve against), how long humans take to answer, which
profiles escalate most, or which blocker descriptions repeat. The
operator-grade question "is the fleet getting more autonomous over
time?" requires opening the DB and joining `escalations` against `pods`
by hand.

## Outcome
A new Escalations card on the analytics dashboard surfaces
**self-recovery rate** (% of terminal pods with no human-attention
escalation) with a daily human-attention-count sparkline; clicking it
opens a drill with three sections — an `ask_human` time-to-respond
histogram (8 log-scale buckets, plus a "X resolved · Y open" header),
a per-profile escalation table (profile · pods · escalated · rate),
and a top-10 blocker description table where each row expands inline
to show up to 10 pod IDs (each clickable through to the pod detail).

## Users
Esben (operator) — tuning his own pod fleet. Operator-grade, not
audit-grade. The drill answers "how often do pods get stuck and need
me, how fast do I respond, where is the noise concentrated, and what
am I being asked the same thing about?". Locked by the master plan
(`docs/analytics-dashboard-plan.md` Audience section).

## Success signal
The operator can show another human, in three clicks from the analytics
dashboard: "self-recovery rate is X% over the last 30 days; my median
ask_human response is Ym; the noisiest blocker is `<description>`
hitting N pods." The endpoint that materialises this is Brief 01's
`GET /pods/analytics/escalations?days=30`, which returns `summary`,
`askHumanTtr`, `perProfile`, `blockerPatterns` in one composite payload
— verified by AC #1 in Brief 01. The user-visible drill is delivered
by Brief 02 with zero ACs by the established desktop-brief precedent
(native macOS profile has no web UI for `web` ACs to fire against);
verification there is via Test expectations on the Codable mirror plus
the diff reviewer.

## Non-goals
- **Throughput card and drill.** Phase 5 in the master plan bundled
  Throughput + Escalations; these spec runs split them. Throughput
  ships in the parallel `analytics-throughput` spec (Phase 5a).
- **Per-profile drill expansion.** The per-profile section is
  stats-only — rows are not clickable. Mirrors Throughput's choice to
  keep only one section in the drill expandable (the heatmap there;
  the blocker patterns table here).
- **TTR for non-`ask_human` escalation types.** The histogram is
  scoped to `ask_human` only — the master plan's literal phrasing.
  Other types (`report_blocker`, `validation_override`,
  `action_approval`) feed the rate calculations and the blocker
  patterns table, but their resolution times are not bucketed.
- **`ask_ai` in the rate or histogram.** `ask_ai` is the
  agent-consults-another-AI path; it's autonomous by design and
  should not count against self-recovery. It's reported as a count
  in the summary and in the card sub-line ("N human · M ai") for
  context, and that's it.
- **`request_credential` in the rate.** JIT credential vending is
  routine and not a sign of stuck-ness. Excluded from human-attention
  count.
- **Real-time updates.** The card refetches on view-mount and on
  days-picker change; no WebSocket subscription. Open-ask_human
  count is point-in-time at request time.
- **Full-text search of blocker descriptions.** Top 10 by count, no
  search box, no fuzzy matching. The pattern table is operator-grade
  triage signal, not a knowledge base.
- **Backfill of historical metrics.** Same forward-only convention as
  every prior phase — escalations table has existed since migration
  001 so this is largely moot, but the design.md spells out the
  cohort-pinning behaviour anyway.
- **Mobile / web analytics surfaces.** macOS only.

## Glossary
- **Self-recovery rate (headline)** — % of terminal cohort pods with
  zero human-attention escalations.
  `(cohortSize - humanAttentionPodCount) / cohortSize`. Formatted as
  a whole-number percentage on the card. Returns 100% when cohort is
  empty (no pods → nothing to recover from); UI suppresses delta in
  that case.
- **Human-attention escalation** — any escalation row with
  `type IN ('ask_human','report_blocker','validation_override','action_approval')`.
  These all require a human to look at and respond. `ask_ai` and
  `request_credential` are explicitly excluded.
- **Sparkline** — daily human-attention escalation count, one entry
  per day in the window, length always equal to `days`. Bucketed by
  `escalations.created_at` daily UTC.
- **Terminal cohort** — Phase 1's locked predicate, applied to the
  rate and per-profile sections:
  `output_mode != 'workspace' AND status IN ('complete','killed','failed')
  AND completed_at >= datetime('now', '-' || @days || ' days')`. The
  rate denominator is `|terminal cohort|`; a pod's escalations count
  if `escalations.pod_id IN cohort`. Pods with no escalations still
  contribute to the denominator.
- **`askHumanTtr` resolved cohort** — `escalations` rows with
  `type='ask_human'` AND `created_at IN window` AND
  `resolved_at IS NOT NULL`. The pod doesn't have to be in the
  terminal cohort — running pods with answered ask_human count.
  Buckets: 8 log-scale ranges:
  `<1m, 1–5m, 5–15m, 15m–1h, 1–4h, 4–12h, 12–24h, >24h`.
  Bucket boundaries in seconds: 60, 300, 900, 3600, 14400, 43200,
  86400. Edges are right-exclusive (a 60.0s response lands in the
  1–5m bucket).
- **`askHumanTtr.openCount`** — count of `escalations` rows with
  `type='ask_human'` AND `created_at IN window` AND
  `resolved_at IS NULL` at request time. Reported alongside resolved
  count in the drill section header. Excluded from the histogram
  itself.
- **Per-profile rate** — `escalatedCount / podCount` per
  `profile_name`, computed over the terminal cohort. Sorted by rate
  DESC, ties broken by `podCount` DESC. Profiles with `podCount < 5`
  are folded into a synthetic `"<small profiles>"` row to avoid
  small-N noise on the card; the synthetic row is suppressed if the
  fold-in count is zero.
- **Blocker pattern** — `description` field of `report_blocker`
  payload (verbatim from `escalations.payload->>'description'`),
  grouped by exact-string equality. Top 10 by count over the window
  (no terminal-cohort restriction — any `report_blocker` in window
  counts). Each pattern carries up to 10 pod IDs (most-recent first
  by `escalations.created_at`); on overflow `+ N more` is shown but
  the IDs themselves are capped at 10 in the response payload.
