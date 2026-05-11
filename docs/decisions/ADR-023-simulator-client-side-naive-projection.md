# ADR-023: Client-side what-if simulator with naïve weighted-average projection

## Status

Accepted

## Context

Analytics phase 6 (`specs/analytics-models/`) includes a
**what-if simulator**: the operator picks a source model, a
target model, and a 0–100% redirect slider, and sees projected
fleet aggregates (cost-per-PR, quality, success rate, mean TTM,
escalation rate) under the counterfactual "what if X% of source
pods had run on target instead?".

The master plan (`docs/analytics-dashboard-plan.md` Phase 6)
described the projection as "based on historical per-model
averages" and called it out as a "Naïve assumption — flag this
clearly in UI". It also flagged an optional server endpoint
(`POST /pods/analytics/simulate`) with the comment "Could also
be done client-side; defer the call."

Two questions to answer:

1. Where does the simulator run — daemon endpoint, or client?
2. What math do we use? A real counterfactual would require a
   pod-by-pod hardness model (selection bias: easier work
   already routes to cheap models, so simply redirecting "30%
   of Opus to Haiku" understates the difficulty of those 30%).
   That's a multi-month research project. The realistic options
   are coarser.

### Option A — Server endpoint, same naïve math

`POST /pods/analytics/simulate` accepts a redirect rule, runs
the same weighted-average projection daemon-side, returns the
result. UI calls it on every slider tick (debounced).

### Option B — Client-side, naïve weighted-average projection

Brief 01's `byModel[]` payload already carries every per-model
aggregate the projection needs. The desktop runs the math in
Swift on every slider tick. No new endpoint, no daemon change.

### Option C — Defer the simulator entirely

Ship the leaderboard + comparison + failure-stage matrix; punt
the simulator to a later phase. Master plan implicitly
considered this by tagging the server endpoint as optional.

### Option D — Build a hardness-aware counterfactual

Train a per-pod difficulty model (using token count,
task-description embedding, profile, etc.) and use it to
re-weight redirected pods. Honest. Multi-month. Not in the
phase-6 budget.

## Decision

**Option B: client-side simulator running naïve
weighted-average math, with a persistent UI caveat banner.**

Brief 03 (`specs/analytics-models/briefs/03-add-models-what-if-simulator.md`)
adds the simulator as a fourth section inside `ModelsDrillView`,
operating purely on the `byModel[]` array Brief 01's endpoint
already returns.

**The projection math.** Let `eligible = byModel.filter(model
!= '<unknown>' && podCount > 0)`. The fleet-wide aggregate for
any axis is a weighted average over `eligible` (weights are
`completeCount` for $/PR and TTM; `scoredCount` for quality;
`podCount` for success rate and escalation rate). To project:
treat `floor(source.podCount × redirectFraction)` source pods
as if they had run on target instead, scaling each per-row
contribution proportionally, then re-run the weighted average.

The simulator's contract assumes **redirected pods inherit
target's historical per-pod averages**. This is the false
assumption. Real-world consequences:

- Selection bias: easier pods may already route to cheaper
  models. Redirecting "the hard 30% of Opus pods" to Haiku
  would not yield Haiku's historical success rate — Haiku's
  historical success rate was measured on the *easier* pods it
  actually saw.
- Compositional effects: if cheap models have higher escalation
  rates because they ask more questions, redirecting volume to
  them will increase escalations more than the naïve projection
  shows (the additional pods will, on average, ask the same
  questions; rare hard pods escalate more than easy ones).

We accept these inaccuracies because:

1. The signal the operator needs is **rough order-of-magnitude
   direction**: "saving $X is plausible if I redirect Y%", not
   "exact future fleet cost will be $Z.ZZ".
2. The UX is a slider, not a forecast — the operator is exploring,
   not committing.
3. A persistent caveat banner ensures the operator never reads
   the projection as a forecast.

**The caveat banner.** Persistent caption-style text above the
simulator controls, verbatim:

> Naïve projection — assumes target model performs identically
> to its past terminal-cohort pods. Validate before committing.

Restrained warning treatment (`!` glyph, muted background). Do
NOT make it dismissible — the warning is load-bearing, not
chrome.

## Consequences

**Easier**

- Zero daemon changes. Brief 01's payload already carries
  everything the simulator needs; Brief 03 is purely a desktop
  view + math module.
- Cheap to compute. Weighted averages over <10 distinct models
  run in microseconds; live updates on every slider tick are
  trivial.
- No round-trip latency on slider drag — the projection feels
  immediate.
- No new endpoint surface, no new error path, no DB hit per
  exploration.
- The math is unit-testable in Swift without spinning up the
  daemon.
- The caveat banner is one place — easy to update the copy
  later as the naïve-assumption framing matures.

**Harder**

- The math lives in two languages if a future phase also wants
  the simulation server-side (e.g. for a CLI surface). Future
  surfaces would re-derive in TS/Python. Mitigation: the
  formulas are documented in Brief 03 and ADR-023 so re-derivation
  doesn't reinvent.
- The naïve assumption *will* mislead some operators. A user
  who runs the simulator, sees "saves $200/mo at 50% redirect",
  acts on it, and gets surprising failure rates is a foreseeable
  failure mode. The banner is the mitigation; if operators
  routinely report being misled, a follow-up phase introduces a
  proper hardness model (Option D).
- The projection's axis-by-axis null handling is subtle: when
  target's `meanTtmSeconds` is null (no complete pods on
  target), the redirected slice contributes no TTM, and the
  projection becomes "fleet TTM excluding the redirected
  source slice". Documented in Brief 03 with unit-test
  coverage, but it's a corner.
- Slider state lives in `@State` on the view; on days-picker
  refetch the state is reset to defaults. A user mid-exploration
  who changes the picker loses their slider position. We accept
  this as acceptable UX (the cohort changed under them; their
  old projection wouldn't be meaningful).

**Committed to**

- The simulator's `byModel[]` consumption is verbatim — adding
  a new field for the simulator means adding it to the wire
  contract first. Today this includes `completeCostUsd` which
  exists specifically for the projection math.
- The caveat-banner copy is canon. Reviewers / future
  contributors who want to soften it route through this ADR.
- The "redirect from one model to another" UI shape (single
  source, single target, single slider). Per-profile redirect
  rules or multi-rule chains are an explicit non-goal of phase
  6; lifting that limit is its own ADR.
- The projection runs over `eligible` (priced, non-zero-podCount
  models). The `<unknown>` bucket is excluded from both the
  baseline and the projection. If a future surface wants
  "compare priced vs unpriced volume", that's a separate axis,
  not an extension of this simulator.

## Alternatives rejected

- **Option A (Server endpoint, same naïve math).** Adds an
  endpoint with no observable accuracy improvement over the
  client-side math. The latency hit (HTTP round-trip per
  slider tick, even debounced) degrades the exploration UX. The
  master plan flagged the endpoint as deferrable; we defer.
- **Option C (Defer the simulator entirely).** Halves the
  phase-6 value proposition. The leaderboard + comparison
  panel answer "what's happening now"; the simulator answers
  "what if I change it" — that's the operator's actual decision
  question. Shipping only "what's happening now" leaves the
  call-to-action stranded.
- **Option D (Hardness-aware counterfactual).** The honest
  answer; the right answer eventually. Out of phase-6 budget
  by an order of magnitude (multi-month research + a per-pod
  difficulty model + validation against held-out pods). If
  phase-6's naïve simulator proves load-bearing and the
  operator routinely makes decisions from it, a follow-up
  phase can revisit Option D with measured demand. Until then,
  shipping the naïve version with an honest caveat is better
  than shipping nothing.
- **Slider with no projection table (just qualitative
  arrows).** Tempting because it avoids the false-precision
  trap. Rejected because operators need to see the order of
  magnitude to act — a green up-arrow alone doesn't answer
  "saves enough to bother". The caveat banner is the right
  mitigation for false precision, not erasing the numbers.
