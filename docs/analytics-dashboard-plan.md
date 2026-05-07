# Analytics Dashboard — Phased Plan

A living plan for the macOS desktop analytics rebuild. Each phase below is sized to be its own `/plan-feature` invocation: self-contained scope, clear data deps, ships user-visible value at the end.

## Status

| # | Phase | Spec | State |
|---|-------|------|-------|
| 0 | Analytics shell | [`specs/analytics-shell/`](../specs/analytics-shell/) | Spec'd |
| 1 | Cost drill-in | [`specs/analytics-cost/`](../specs/analytics-cost/) | Spec'd |
| 2 | Lifecycle funnel + reliability | [`specs/analytics-reliability-funnel/`](../specs/analytics-reliability-funnel/) | Spec'd |
| 3 | Quality drill-down | [`specs/analytics-quality/`](../specs/analytics-quality/) | Spec'd |
| 4 | Safety / Guardrails | — | Pending |
| 5 | Throughput, heatmap, escalations | — | Pending |
| 6 | Models leaderboard + what-if | — | Pending |

ADRs introduced so far: [ADR-015](decisions/ADR-015-model-pricing-bundled-json.md) (bundled JSON pricing), [ADR-016](decisions/ADR-016-phase-token-per-attempt-taxonomy.md) (per-attempt phase token taxonomy).

## Vision

Turn the existing `AnalyticsView` from a stats wall into a **drill-in dashboard**. Three-pane shell becomes:

```
SIDEBAR                  MIDDLE: card grid          RIGHT: persistent drill-in
─ Analytics              ┌──────┐ ┌──────┐         ┌────────────────────┐
  ▸ Cost                 │ Cost │ │Quality│        │ <last-clicked card │
  ▸ Reliability          └──────┘ └──────┘         │  in deep view>     │
  ▸ Quality              ┌──────┐ ┌──────┐         │                    │
  ▸ Safety               │ Safe │ │ Speed│         │ histograms,        │
  ▸ Throughput           └──────┘ └──────┘         │ tables, drill-down │
  ▸ Models               ┌──────────────┐          │ → "open workspace" │
                         │ Funnel       │          └────────────────────┘
                         └──────────────┘
```

Every card has a sparkline + delta. Every card opens a deep view in the right pane. Right pane is its own scene state, separate from the fleet detail panel.

**Audience:** the operator (Esben), tuning his own pod fleet. Not auditors, not managers. So the safety story is a feature, not the headline. Cost / quality / reliability lead.

## Cross-cutting principles

- **Native first.** SwiftUI Charts for bar / line / area / heatmap. Custom `Path` for funnel + sankey only where it's worth the effort. No WebView.
- **Right-pane state is independent of fleet selection.** Switching to fleet view doesn't blow away the analytics drill-down.
- **Every drill-in has an "Open as workspace" CTA.** Reuses existing `history-workspace` to launch a forensic pod against the filtered set.
- **No backfill of historical metrics.** New tables capture forward; existing tables already have what we need for the rest.

## Established conventions (locked by Phase 0 + Phase 1)

Future phases consume these as-is — don't re-litigate during `/plan-feature`.

- **Card API** (Phase 0): `AnalyticsCard` takes `title: String`, `value: String`, `sparkline: [Double]?`, `delta: AnalyticsCardDelta?`, `isSelected: Bool`, `onClick: () -> Void`. Pre-formatted strings, not numbers. Source: `specs/analytics-shell/design.md`.
- **Card kind enum** (Phase 0): `AnalyticsCardKind` is an enum with `.cost`, `.quality`, `.status`. New phases extend the enum with their card kind (e.g. `.reliability`, `.safety`, `.throughput`, `.models`).
- **Right-pane routing** (Phase 0): `AnalyticsRightPaneView` switches on `AnalyticsCardKind?` and renders `<Kind>DrillView`. New phases add a private drill view, not a new routing layer.
- **Sidebar sub-rows** (Phase 0): every analytics sub-row exists but ships `.disabled(true)`. Enabling a sub-row is part of the phase that fills its drill.
- **Trailing-window query** (Phase 1): `datetime('now', '-' || @days || ' days')`. Precedent: `quality-score-repository.ts:167`. Default window is 30 days; endpoints accept `?days=N` (≥ 1).
- **Pod filter** (Phase 1): every analytics aggregation applies `isWorkspace = false` AND `status IN ('complete','killed','failed','rejected')` AND `completedAt` ∈ window. Don't widen without superseding `purpose.md` non-goals.
- **Effective cost** (Phase 1, ADR-015): `effectiveCostUsd(pod) = pod.costUsd > 0 ? pod.costUsd : computeCost(model, in, out)`. Anything that surfaces a $ value uses this helper, not raw `pod.costUsd`.
- **Phase token taxonomy** (Phase 1, ADR-016): `phase_token_usage` carries `agent_initial`, `agent_rework_<N>`, `review`, `plan_eval`. Pre-Phase-1 pods reconstruct as synthetic `agent_legacy` at aggregation time. Forward-only — no backfill.
- **Endpoint shape** (Phase 1): one composite endpoint per card (`GET /pods/analytics/<kind>?days=N`) returning everything the drill needs. Don't fan out into per-section endpoints.
- **Audience** (cross-cutting): operator-grade for Esben. Not audit-grade. Skip PDF exports, retention guarantees, compliance attestation.

## What each phase delivers

Each phase ships a working slice: migration (if any) → daemon endpoint → Swift API client → middle-pane card → right-pane drill-in.

---

## Phase 0 — Analytics shell

**Goal:** scaffolding that all later phases plug into. No new analytics, just the chassis.

**Scope**
- Add sub-route entries under the existing `Analytics` sidebar item (`Cost`, `Reliability`, `Quality`, `Safety`, `Throughput`, `Models`). Default route = overview.
- Convert middle pane into a responsive card grid container that other phases can register cards into.
- Add a separate right-pane scene state for analytics (not the pod detail panel). Persists across pod selection changes.
- Stub a generic `AnalyticsCard` view (title, big number slot, sparkline slot, delta-vs-prior slot, click target).
- Wire the existing top-level cards (Cost, Quality, Status distribution) into the new card grid as a no-op migration so the shell is exercised end-to-end.

**Daemon work:** none.

**Done when:**
- All sidebar sub-routes navigate without crashing.
- Existing analytics still render.
- Clicking any of the migrated cards opens *something* in the right pane (even a placeholder).

**Files likely touched:** `MainView.swift`, `SidebarView.swift`, `AnalyticsView.swift`, new `AnalyticsCard.swift`, new `AnalyticsRightPane.swift`.

---

## Phase 1 — Cost drill-in

**Goal:** answer "where does my money go?" at fleet, profile, model, and per-phase grain.

**Scope**
- Cost card in middle pane: 30d total, sparkline, delta vs prior 30d, $/merged-PR, wasted-on-killed.
- Right-pane drill:
  - Per-phase stacked bar, sourced from `pods.phase_token_usage` JSON (already populated by migration `089_pod_phase_token_usage.sql`).
  - Breakdown by profile × model (matrix or grouped bars).
  - Top 10 most expensive pods (clickable → opens that pod's overview).
  - "Cost waste" summary: $ spent on `killed`, `rejected`, `failed` final states.

**Daemon work**
- New endpoint: `GET /pods/analytics/cost?from=&to=&groupBy=phase|profile|model`. Aggregates over `pods` table; parses `phase_token_usage` JSON server-side.

**Done when:** clicking the Cost card lets me find — in under three clicks — the pod that blew yesterday's budget.

**Risks / open Qs for /plan-feature**
- `phase_token_usage` JSON shape stability — confirm all phase keys before grouping.
- Currency rounding strategy (already cents-rounded? confirm).

---

## Phase 2 — Lifecycle funnel + reliability

**Read first:** `specs/analytics-shell/design.md` (card + right-pane contracts), `specs/analytics-cost/design.md` (trailing-window + pod filter conventions), `packages/daemon/src/db/migrations/` for the latest validation/state-history columns.

**Goal:** show *where pods leak* through the state machine, and *which validation stage* is the most common failure mode.

**Scope**
- Funnel diagram (custom `Path`-based, eight bands: queued → provisioning → running → validating → validated → approved → merging → complete). Each band shows the count and the drop count to the next.
- Reliability card: first-pass success %, top failure stage, avg `rework_count`.
- Right-pane drill:
  - Click any drop → list of pods that exited at that band (with terminal status).
  - Failure-stage breakdown (build / health / smoke / lint / sast / acValidation / taskReview) from `validations` table.
  - Per-profile failure heatmap (profile rows × stage cols).

**Daemon work**
- New endpoint: `GET /pods/analytics/funnel?from=&to=&profile=`. Returns counts per state and exit-state distribution.
- New endpoint: `GET /pods/analytics/validation-failures?from=&to=`. Aggregates `validations.result` JSON for per-stage failure rates.

**Done when:** I can identify the single weakest validation stage for the past week and click through to the failing pods.

---

## Phase 3 — Quality drill-down

**Read first:** `specs/analytics-shell/design.md`, `specs/analytics-cost/design.md`, `packages/daemon/src/pods/quality-score-repository.ts` (existing scoring).

**Goal:** upgrade the existing quality view to actually be diagnostic, not just descriptive.

**Scope**
- Replace current quality card with: score sparkline, distribution mini-histogram, "n pods low-quality (<60)" callout.
- Right-pane drill:
  - Full 0–100 histogram (bucketed).
  - Sortable table from `pod_quality_scores` (already exists): score, profile, runtime, model, cost, completed-at, pod link.
  - Low-quality reason breakdown: low read/edit ratio, edits-without-prior-read count, user-interrupt count.
  - Click any row → opens that pod with the Quality tab focused.

**Daemon work**
- New endpoint: `GET /pods/analytics/quality?from=&to=&minScore=&maxScore=`. Filterable view over `pod_quality_scores`.

**Done when:** I can answer "show me the bottom 20% of last week's pods, sorted by cost" without opening the database.

---

## Phase 4 — Safety / Guardrails

**Read first:** `specs/analytics-shell/design.md`, `specs/analytics-cost/design.md`, `packages/daemon/src/actions/action-audit-repository.ts` (PII / quarantine columns), `packages/shared/src/sanitize/` (pattern definitions), `packages/daemon/src/pods/issue-watcher-service.ts` (the writer hook for `safety_events`). This is the first phase that introduces a new table — bump the migration prefix off the highest existing one (see `CLAUDE.md` Database / Migrations rule).

**Goal:** prove guardrails are working, with a real story in numbers. Operator-grade, not audit-grade.

**Scope**
- Safety hero card: PII redactions count, quarantine flag count (with high-risk count), injection blocks count, trend sparklines.
- Right-pane drill:
  - PII redactions by type (api-key, email, azure-conn, github-pat, aws-akia, jwt, …) — sourced from `action_audit.pii_detected` joined with the parsed `params` to bucket by pattern category. *Decision needed:* either re-parse params at query time, or add a `pii_categories` column.
  - Quarantine score distribution histogram from `action_audit.quarantine_score`.
  - Injection attempts list — **requires new persistence**: `safety_events` table (id, pod_id, type, pattern_name, severity, payload_excerpt, created_at). Hook into `issue-watcher-service.ts:147` so detections persist instead of being log-only.
  - Audit chain integrity widget: "Last verified Xm ago, N entries, 0 mismatches". New endpoint to verify the hash chain on demand.
  - Network policy distribution: % pods on allow-all / restricted / deny-all over time.

**Explicitly out of scope (with reason)**
- Firewall block logging via iptables LOG → counters table. Big infra lift; current REJECT mode produces no signal. Defer until we hear an actual user need.
- Container log retention. Storage trap; the proof isn't *in* the logs but in the *absence* of cross-boundary events. Use the existing `history-workspace` flow for forensic drill-downs instead.

**Daemon work**
- New migration: `safety_events` table.
- Modify `issue-watcher-service.ts` to insert into `safety_events` on detection.
- New endpoint: `GET /pods/analytics/safety?from=&to=`. Aggregates from `action_audit` + `safety_events` + `pods.network_policy`.
- New endpoint: `POST /audit-chain/verify`. Walks `action_audit` hash chain, reports first mismatch (if any).

**Done when:** I can show someone "guardrails fired N times this month, here's exactly which patterns and on which pods, audit chain verified".

---

## Phase 5 — Throughput, heatmap, escalations

**Read first:** `specs/analytics-shell/design.md`, `specs/analytics-cost/design.md`, `packages/daemon/src/pods/escalation-repository.ts`, `packages/daemon/src/pods/pod-repository.ts` (state transition timestamps).

**Goal:** answer "how busy is this thing, when, and what's blocking forward motion?"

**Scope**
- Throughput card: pods/day, MTTM (mean time to merge), current backlog.
- Right-pane drill:
  - Hour-of-day × day-of-week heatmap (cells clickable → pods in that window).
  - Queue depth time-series (derived from `pods.created_at` minus `pods.started_at`).
  - Time-in-status box plot per state.
- Separate Escalations card: total, ask_human vs ask_ai split, self-recovery rate (% pods completed without escalation).
- Right-pane drill for Escalations:
  - Time-to-resolve distribution for `ask_human`.
  - Per-profile escalation rate.
  - Top blocking patterns (cluster `report_blocker` payloads — start naïve, just frequency-counted strings).

**Daemon work**
- New endpoint: `GET /pods/analytics/throughput?from=&to=`. Bucketed counts by hour-of-day × day-of-week, plus time-in-status percentiles.
- New endpoint: `GET /pods/analytics/escalations?from=&to=`. Aggregates from `escalations` table.

**Done when:** I can spot my busiest day-of-week pattern and see whether escalations cluster around specific profiles.

---

## Phase 6 — Models leaderboard + what-if

**Read first:** `specs/analytics-shell/design.md`, `specs/analytics-cost/design.md`, `packages/shared/src/pricing/` (the pricing module; what-if math runs through `effectiveCostUsd`), prior phases' aggregation modules for per-model rollup precedent.

**Goal:** make model-mix decisions data-driven, not vibes-driven.

**Scope**
- Models card: best $/PR, best quality, most-used.
- Right-pane drill:
  - Side-by-side comparison: Claude vs Codex vs Copilot, broken down by success rate, $/PR, avg quality, median time-to-merge, escalation rate.
  - Per-model failure-stage breakdown.
  - **What-if simulator:** slider per profile to redirect a % of pods from one model to another, see projected change in cost / quality / success rate based on historical per-model averages. Naïve assumption — flag this clearly in UI.

**Daemon work**
- New endpoint: `GET /pods/analytics/models?from=&to=`. Per-model aggregate stats.
- Optional: `POST /pods/analytics/simulate` — same data, but with a redirect rule applied. Could also be done client-side; defer the call.

**Done when:** I can confidently say "if I shift 30% of web-stack from Opus to Sonnet, I'll save $X but expect Y% more rework" — and have the data to back it.

---

## Phase order rationale

1. **0** is foundation — everything else assumes the shell.
2. **1 (Cost)** → biggest operator value, data already exists, validates the drill-in pattern end-to-end.
3. **2 (Funnel)** → second-biggest operator value, also validates the custom `Path` chart approach for later phases.
4. **3 (Quality)** → mostly UI, low risk, gets us comfortable with the right-pane table pattern.
5. **4 (Safety)** → first phase needing a new table + writer-side change; do it once the UI patterns are settled.
6. **5 (Throughput)** → adds the heatmap pattern.
7. **6 (Models)** → most ambitious because of the simulator; do it last when we have all the per-model data plumbing already in place from earlier phases.

Phases 1–3 are independent after Phase 0 ships and could be parallelized if we wanted. Phases 4–6 each have prereqs (4 needs a writer change; 5 reuses 1's bucketing; 6 reuses everything).

## Deferred / explicit non-goals

- Firewall iptables LOG → block-counter table.
- Container log retention.
- Auth failure / rate-limit / token validation persistence (operator dashboard, not in scope).
- Full audit-grade reporting (PDF exports, retention guarantees, compliance attestation).
- Mobile/web analytics surfaces. macOS only.

## How to use this doc

For each phase, run `/plan-feature` and paste the corresponding section as the seed. The plan-feature skill will interview, scan the codebase, and produce a `specs/<phase-name>/` folder with `purpose.md`, `design.md`, and per-module briefs.

After a phase is spec'd, update the Status table at the top of this doc with a link to its `specs/<phase-name>/` folder so progress is trackable from one place.

Suggested phase names for `/plan-feature`:
- `analytics-shell` ✅
- `analytics-cost` ✅
- `analytics-reliability-funnel`
- `analytics-quality`
- `analytics-safety`
- `analytics-throughput`
- `analytics-models`
