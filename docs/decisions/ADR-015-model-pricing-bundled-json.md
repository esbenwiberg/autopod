# ADR-015: Model pricing as bundled JSON in @autopod/shared

## Status
Accepted

## Context

Cost analytics need a per-model price catalog so pods that don't carry a
native `costUsd` (Codex, Copilot) can be assigned a dollar figure from
their token counts. Today only Claude pods populate `pod.costUsd` from
the runtime stream's `total_cost_usd` field
(`packages/daemon/src/runtimes/claude-stream-parser.ts:180`); Codex
emits `total_token_usage` (no cost), Copilot is similar. Without a
pricing source, the cost endpoint reports $0 for any non-Claude pod and
the "where does my money go?" question can't be answered honestly.

Pricing data has three uncomfortable properties:

1. **It decays.** Anthropic / OpenAI change prices irregularly, with no
   webhook. Any auto-fetch is its own integration to maintain.
2. **It's small.** A few dozen models × two numbers each. Whatever shape
   we pick, the data fits in a single small JSON document.
3. **The user is solo.** Esben is the only operator; there is no
   multi-tenant or per-org pricing override scenario today.

## Decision

Pricing lives at `packages/shared/src/pricing/model-pricing.json`, owned
by the `@autopod/shared` package. Shape:

```json
{
  "claude-opus-4-7":    { "inputPer1M": 15.00, "outputPer1M": 75.00 },
  "claude-sonnet-4-6":  { "inputPer1M": 3.00,  "outputPer1M": 15.00 },
  "gpt-5":              { "inputPer1M": 1.25,  "outputPer1M": 10.00 }
}
```

Keys are exact model IDs as stored in `pod.model` (the same string the
runtime reports). Values are USD per 1 000 000 tokens.

The daemon imports the JSON, exposes `effectiveCostUsd(pod)` and
`computeCost(model, inputTokens, outputTokens)` helpers, and uses them
at aggregation time:

```ts
effectiveCost = pod.costUsd > 0 ? pod.costUsd : computeCost(pod.model, ...)
```

Refresh policy: **manual only**. When prices change, edit the JSON,
rebuild, redeploy. No auto-fetch, no scheduled job, no admin endpoint.
Unknown models (key missing) compute to $0 with a warn log line; this
is acceptable because the daemon already requires `pod.model` to be
set on terminal pods (see `quality-score-recorder.ts`).

## Consequences

Easier:
- Fleet cost numbers are honest across runtimes from day one.
- Editing a price is a one-line PR.
- No new infrastructure (no DB table, no admin UI, no migration).

Harder:
- Outdated catalog → silently wrong analytics. Mitigation: a unit test
  asserts every model present in `pod.model` rows in a fixture has a
  pricing entry; surface unknown-model warns.
- Cached cost numbers won't auto-recompute when prices change because
  aggregation is computed live from tokens — actually this is a
  feature, not a bug: editing the JSON retroactively re-prices history.

Committed to:
- The catalog file path and shape. Future code reads it as a stable
  contract.
- "No auto-fetch" stance. If future scale demands it, a follow-up ADR
  supersedes this one.
