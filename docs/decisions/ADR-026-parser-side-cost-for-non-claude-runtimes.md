# ADR-026: Parser-side `costUsd` emission for runtimes without native cost

## Status

Accepted

## Context

ADR-015 introduced `packages/shared/src/pricing/model-pricing.json` and the `computeCost(model, in, out)` / `effectiveCostUsd(pod)` helpers. Its decision was that cost computation happens at **aggregation time** for runtimes without a native cost field, with `effectiveCostUsd(pod)` returning `pod.costUsd` when non-zero and falling back to `computeCost(pod.model, pod.inputTokens, pod.outputTokens)` otherwise.

In practice today:

- **Claude pods** populate `pod.costUsd` from each `AgentCompleteEvent.costUsd`, which the parser sources from the CLI's `total_cost_usd` field (`claude-stream-parser.ts:184`). Pod-manager accumulates via the runtime-agnostic site at `pod-manager.ts:4835`.
- **Codex pods** emit no native cost field. The parser doesn't set `AgentCompleteEvent.costUsd`. Pod-manager's accumulator runs but adds `0` each turn, so `pod.costUsd` stays at 0.
- **A handful of read sites still call `pod.costUsd` directly** rather than `effectiveCostUsd(pod)` — at least `history-exporter.ts:233`, `quality-signals.ts:179`, `quality-score-recorder.ts:63`. These undercount Codex cost in their respective surfaces (history CSV export, quality signals output, quality score recorder logs). ADR-015 acknowledged this as "stragglers to migrate."

The codex-parity spec surfaced a second pressure that ADR-015 didn't directly address: the CLI `ap pod watch` and desktop activity feed render `AgentCompleteEvent.costUsd` **live during the run**. For Claude pods, users see a dollar figure on completion. For Codex pods, they see `undefined` / nothing. Even if analytics catches up at read time via `effectiveCostUsd`, the live UX advertises Codex as cost-blind.

Two paths existed:

- **(A)** Migrate the stragglers to `effectiveCostUsd(pod)` and accept that live `AgentCompleteEvent.costUsd` stays undefined for non-Claude runtimes.
- **(B)** Have non-Claude parsers compute `costUsd` at turn-complete via the shared helper and emit it on `AgentCompleteEvent`. `pod.costUsd` then populates correctly for Codex; stragglers self-heal via the `effectiveCostUsd` early return on `pod.costUsd > 0`.

## Decision

**Option B.** Non-Claude runtime parsers compute `costUsd` at the equivalent of Claude's `result` event (Codex: `turn_complete`) using `computeCost(model, inputTokens, outputTokens)` from `@autopod/shared/pricing`. The computed value is set on the emitted `AgentCompleteEvent.costUsd`. Pod-manager's existing accumulator at `pod-manager.ts:4835` adds the value to `currentSession.costUsd` runtime-agnostically. No pod-manager change is needed; the read-side accumulator was always runtime-agnostic — it just wasn't being fed for non-Claude.

The model is captured by the parser from the runtime's session-config event (Codex: `session_configured.model`) and carried as parser state alongside `latestUsage` until `turn_complete` fires. Both flush together into the emitted `AgentCompleteEvent`.

## Consequences

**Easier**

- Live `AgentCompleteEvent.costUsd` parity. `ap pod watch` and the desktop activity feed show a real dollar figure for every Codex pod run, matching Claude UX exactly. The "Codex pods feel second-class" symptom that motivated codex-parity is materially addressed.
- `pod.costUsd` column is populated for Codex pods. The three known stragglers self-heal without code change: `effectiveCostUsd(pod)` returns `pod.costUsd` via the early return on `> 0`, and the stragglers already call `pod.costUsd` directly.
- Future runtimes without a native cost field (Copilot when JSON output lands at [github/copilot-cli#52](https://github.com/github/copilot-cli/issues/52)) follow the same pattern uniformly: capture model from the runtime's session-config event, call `computeCost` at completion, emit `costUsd`.

**Harder**

- The Codex parser imports from `@autopod/shared/pricing` — a new daemon-runtime → shared edge that didn't exist before. Parsers previously only imported from `shared/types`. Tiny pure-function import, but it does widen the dependency graph for the runtime layer.
- Two computation sites now exist for the same number: parsers at write time, `effectiveCostUsd` at read time. They MUST stay consistent. Mitigation: both call into the same `computeCost` helper. Drift is impossible by construction.
- The "retroactive repricing when JSON changes" property of ADR-015 is partially lost for Codex — once written, `pod.costUsd` is sticky (same as Claude today). ADR-015 framed this as "actually a feature, not a bug" for Claude; the same framing extends to Codex.

**Committed to**

- Non-Claude parsers carry the model in their state and call `computeCost` at the equivalent of `turn_complete`. New runtimes follow this pattern.
- The pricing JSON remains the single source of truth. No per-runtime price tables. No env-var overrides. Manual-refresh stance from ADR-015 stays.
- The `AgentCompleteEvent.costUsd` field semantics stay as defined: "USD cost of this turn, populated when known." Authoritative for Claude (from API); computed-via-tokens for runtimes without native cost.

## Amends, not supersedes

ADR-015's read-time aggregation pattern (`effectiveCostUsd`) remains the canonical entry point for any code that reads cost. This ADR augments the *write* side for runtimes that previously left `pod.costUsd = 0`. ADR-015 is still Accepted; nothing it decided is reversed.

If a future ADR introduces a runtime with a *real* native cost field (e.g. an API that returns `total_cost_usd` like Claude does), that runtime's parser reads-and-emits rather than computes — same shape, different source. The decision tree at the parser layer is: "if the runtime emits a cost, use it; otherwise, compute via shared pricing."

## Alternatives rejected

- **Option A — migrate the stragglers only, leave parser untouched.** Leaves the live UX asymmetric. Users see "$0.04" on Claude completion and nothing on Codex completion. The "parity" goal of the surrounding codex-parity spec is materially undermined — operators continue perceiving Codex as second-class even after analytics catches up days later. The stragglers self-heal under Option B regardless, so Option A leaves us with the worse outcome and no additional benefit.
- **Persist a separate `computed_cost_usd` column on `pods`.** Adds a column for zero read-time benefit (we already derive from `inputTokens` × `outputTokens` × `model` at read time via `effectiveCostUsd`). Doesn't address the live-UX problem either — the parser still wouldn't emit a value on `AgentCompleteEvent.costUsd`. Strictly worse than B.
- **Move cost computation out of the parser into pod-manager's accumulator.** Pod-manager could read tokens from the `AgentCompleteEvent` and call `computeCost` before writing to DB. This would keep the parser pure-types. Rejected because the parser also needs to set `AgentCompleteEvent.costUsd` itself for the live-UX path (CLI watch, desktop renderers consume the AgentEvent stream, not pod-manager's DB writes). Computing in two places would be the worst of both worlds.

## References

- ADR-015: Model pricing as bundled JSON in `@autopod/shared`. The decision this ADR amends.
- ADR-022: `MODEL_CANONICAL` alias map. The aliasing mechanism this ADR's `computeCost` call relies on indirectly (the parser passes the raw model string from `session_configured`; `MODEL_PRICING` lookup may need to canonicalise via `MODEL_CANONICAL` if the runtime emits a short alias).
- `specs/codex-parity/` — the spec that surfaced the live-UX gap.
- `packages/shared/src/pricing/index.ts` — `computeCost`, `effectiveCostUsd`, `MODEL_PRICING`, `MODEL_CANONICAL`.
- `packages/daemon/src/runtimes/claude-stream-parser.ts:181-205` — the Claude `result` → `AgentCompleteEvent` mapping. The Codex parser builds the parallel path, computing rather than reading.
- `packages/daemon/src/pods/pod-manager.ts:4812-4836` — the runtime-agnostic accumulator. No change needed; the value flows once the parser emits it.
