# ADR-022: `MODEL_CANONICAL` alias map for analytics rollups

## Status

Accepted

## Context

Analytics phase 6 (`specs/analytics-models/`) introduces
per-model rollups: a leaderboard, a side-by-side comparison
panel, a per-model failure-stage matrix, and a client-side
what-if simulator. Every rollup keys aggregates by
`pods.model` — but that column is a free-form string written by
whatever code spawned the pod.

`packages/shared/src/pricing/model-pricing.json` already
contains both canonical model IDs (`claude-opus-4-7`,
`claude-sonnet-4-6`, `claude-haiku-4-5`) and short aliases
(`opus`, `sonnet`, `haiku`) with **duplicate price entries**.
The aliases exist because `profile.defaultModel` can be set to
either form — the `computeCost` helper looks the key up in
`MODEL_PRICING` and uses whatever it finds, so duplication
works for pricing.

For analytics, duplication is a footgun. A profile that sets
`defaultModel: 'opus'` and another that sets
`defaultModel: 'claude-opus-4-7'` will both call into the same
underlying model, but their pod rows carry different
`pods.model` strings. Grouping the leaderboard by
`pods.model` directly bisects Opus stats into two rows —
"Opus" with half the cohort, "Claude Opus 4.7" with the other
half. The cheapest-$/PR headline picks the wrong one,
quality averages are diluted, and the what-if simulator's
source/target dropdowns offer the operator two choices for what
is the same model.

There are three ways to fix this:

### Option A — Coalesce in JS via a hand-maintained alias map

A small `Record<alias, canonical>` map exported alongside
`MODEL_PRICING`. Every analytics path applies a
`canonicalModelKey(rawModel)` helper before keying its rollup.
Unrecognised model strings (neither canonical nor aliased)
return `null` and bucket under a literal `<unknown>` row.

### Option B — Deduplicate the pricing JSON, change `MODEL_PRICING` to use aliases

Remove the canonical keys from `model-pricing.json`, keep only
the short aliases. `computeCost` looks them up directly.
Analytics groups by the resulting (short) keys.

### Option C — Persist a `canonical_model` column on `pods` at write time

Add a column, populate at pod creation by canonicalising
`pods.model` once. Analytics groups by `canonical_model`. No
runtime coalescing.

## Decision

**Option A: introduce `MODEL_CANONICAL` and `canonicalModelKey`
in `packages/shared/src/pricing/index.ts`.**

```ts
export const MODEL_CANONICAL: Readonly<Record<string, string>> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

export function canonicalModelKey(
  model: string | null | undefined,
): string | null {
  if (!model) return null;
  if (model in MODEL_PRICING) return model;
  const aliased = MODEL_CANONICAL[model];
  if (aliased && aliased in MODEL_PRICING) return aliased;
  return null;
}
```

The map is additive — adding new aliases never breaks existing analytics paths.
It is the source of truth for the three historical short aliases
(`opus`, `sonnet`, `haiku`). Pricing helpers canonicalize through the map,
so the pricing JSON contains canonical IDs only.

Unrecognised models — neither a `MODEL_PRICING` key nor a
known alias — coalesce to `null` from `canonicalModelKey()`
and bucket under a literal `<unknown>` row in the analytics
response. The `<unknown>` row carries `totalCostUsd: null` and
`dollarPerPr: null` (we can't price unrecognised models); it
still carries volume / quality / TTM / escalation values
because those don't depend on pricing. The unrecognised raw
strings are surfaced separately under `unknownModels[]` (capped
at 10 entries) so the operator can see which models need
adding to the pricing catalog.

## Consequences

**Easier**

- One-line cure for the alias-bisection footgun: every analytics
  rollup calls `canonicalModelKey()` on the way out of the
  query and the rest of the code is unchanged.
- Backwards-compatible — `computeCost`, `computeCostWithCache`, and
  `effectiveCostUsd` canonicalize raw model strings before price lookup.
  Adding a historical alias is one mapping to an existing canonical price key;
  no duplicate price row is required.
- The `<unknown>` bucket is observable, not silent. Operators
  see a row + a sample list of unrecognised strings and know to
  update the catalog. Today's behaviour (silent zero-cost) was
  worse.
- Pricing JSON stays intact — no risk of accidentally repricing
  a model by editing the wrong row.

**Harder**

- `MODEL_CANONICAL` is hand-maintained. A missing mapping leaves the raw
  string unknown to both analytics and pricing. Shared pricing tests lock the
  historical mappings and verify that aliases never re-enter the canonical
  price table.
- Analytics has a second consumer of model strings besides
  pricing. Future code adding new model-keyed rollups must
  remember to coalesce. The convention is "key analytics by
  `canonicalModelKey()`, never by raw `pods.model`"; the spec
  notes this in `design.md` → "Alias coalescing".
- An `<unknown>` row visible in the leaderboard might confuse
  operators who don't realise it represents unrecognised
  model strings. The drill's `unknownModels[]` sample list and
  a tooltip mitigate this.

**Committed to**

- `MODEL_CANONICAL` lives in `packages/shared/src/pricing/`,
  not in a separate `model-aliases.ts`. The pricing module is
  the canonical home for "everything about model identity".
- The `<unknown>` bucket key is the literal string
  `<unknown>` (angle brackets included). Mirrors phase 5b's
  synthetic `<small profiles>` row convention.
- The unknown-row pricing fields are null, not zero. Zero
  would silently win the cheapest-$/PR headline.

## Alternatives rejected

- **Option B (Deduplicate pricing JSON, use aliases as keys).**
  Aliases like `opus` are not the canonical model identifier
  used by Anthropic's API — they're a convenience nickname. The
  full IDs (`claude-opus-4-7`) are what appears in CLI output,
  in API headers, and in user-facing documentation. Forcing
  every analytics consumer (and every desktop screen) to read
  `opus` instead of `claude-opus-4-7` is regressive. We want
  canonical IDs everywhere except the input layer (profile
  defaultModel), which is exactly the shape this ADR adopts.
- **Option C (Persist `canonical_model` on `pods`).** Cheaper at
  query time but more expensive everywhere else: a new migration,
  a column whose value depends on a JS map (so backfilling
  requires running the map's contents through SQL), and a
  future-alias-added scenario requires rewriting historical
  pod rows. Coalescing at read time is O(N) over the trailing
  window — at the largest realistic fleet sizes that's
  microseconds. The persistence-cost vs analytics-velocity
  tradeoff isn't worth it for a single-developer fleet.
