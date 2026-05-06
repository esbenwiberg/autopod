---
title: "Add model pricing module to @autopod/shared"
acceptance_criteria: []
touches:
  - packages/shared/src/pricing/model-pricing.json
  - packages/shared/src/pricing/index.ts
  - packages/shared/src/pricing/index.test.ts
  - packages/shared/src/index.ts
does_not_touch:
  - packages/daemon/
  - packages/desktop/
  - packages/cli/
  - packages/shared/src/types/pod.ts
---

## Task

Pure additive brief in `@autopod/shared`. Introduces the model pricing
catalog and the helpers everything else will use to compute dollars
from token counts. Nothing consumes these helpers in this brief —
Brief 03 will.

### `model-pricing.json`

New file at `packages/shared/src/pricing/model-pricing.json`. Shape
matches ADR-015. Seed values (USD per 1M tokens, current at time of
writing — verify and update if vendors have moved):

```json
{
  "claude-opus-4-7":     { "inputPer1M": 15.00, "outputPer1M": 75.00 },
  "claude-sonnet-4-6":   { "inputPer1M": 3.00,  "outputPer1M": 15.00 },
  "claude-sonnet-4-5":   { "inputPer1M": 3.00,  "outputPer1M": 15.00 },
  "claude-haiku-4-5":    { "inputPer1M": 1.00,  "outputPer1M": 5.00 },
  "gpt-5":               { "inputPer1M": 1.25,  "outputPer1M": 10.00 },
  "gpt-5-mini":          { "inputPer1M": 0.25,  "outputPer1M": 2.00 },
  "opus":                { "inputPer1M": 15.00, "outputPer1M": 75.00 },
  "sonnet":              { "inputPer1M": 3.00,  "outputPer1M": 15.00 },
  "haiku":               { "inputPer1M": 1.00,  "outputPer1M": 5.00 }
}
```

The short aliases (`opus`, `sonnet`, `haiku`) are present because
`profile.defaultModel` defaults to `'opus'` — so some pods land in the
DB with a short name rather than a full model ID. Both lookups must
work.

### `pricing/index.ts`

```ts
import pricingData from './model-pricing.json' with { type: 'json' };

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> =
  pricingData as Record<string, ModelPrice>;

export function computeCost(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!model) return 0;
  const price = MODEL_PRICING[model];
  if (!price) return 0;
  return (
    (inputTokens / 1_000_000) * price.inputPer1M +
    (outputTokens / 1_000_000) * price.outputPer1M
  );
}

export function effectiveCostUsd(pod: {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}): number {
  if (pod.costUsd > 0) return pod.costUsd;
  return computeCost(pod.model, pod.inputTokens, pod.outputTokens);
}
```

JSON import syntax: the project uses ESM with `tsup`. Use the
`with { type: 'json' }` import attribute. If the build fails on this,
fall back to `import pricingData from './model-pricing.json'` with a
`resolveJsonModule` tsconfig setting (it's already on per
`tsconfig.base.json`'s `strict` settings). Prefer the import attribute
form — it's the spec-blessed shape.

### Re-export from package root

Add to `packages/shared/src/index.ts`:

```ts
export * from './pricing/index.js';
```

### Tests

`packages/shared/src/pricing/index.test.ts`:

- `MODEL_PRICING` contains expected keys (`claude-opus-4-7`, `gpt-5`,
  the short aliases).
- `computeCost('claude-opus-4-7', 1_000_000, 0)` returns `15.00`.
- `computeCost('claude-opus-4-7', 0, 1_000_000)` returns `75.00`.
- `computeCost('claude-opus-4-7', 500_000, 500_000)` returns
  `7.50 + 37.50 = 45.00`.
- `computeCost(null, 100, 100)` returns `0`.
- `computeCost('unknown-model', 100, 100)` returns `0`.
- `effectiveCostUsd({ costUsd: 1.23, ... })` returns `1.23`
  (Claude path).
- `effectiveCostUsd({ costUsd: 0, model: 'gpt-5', inputTokens:
  1_000_000, outputTokens: 0 })` returns `1.25` (computed path).
- `effectiveCostUsd({ costUsd: 0, model: 'unknown', ... })` returns
  `0` (unknown-model path; warns are out of scope here).

## Touches

- `packages/shared/src/pricing/model-pricing.json` (new)
- `packages/shared/src/pricing/index.ts` (new)
- `packages/shared/src/pricing/index.test.ts` (new)
- `packages/shared/src/index.ts` (one new re-export line)

## Does not touch

- Anything in `packages/daemon/`, `packages/desktop/`, `packages/cli/`.
- `packages/shared/src/types/pod.ts` — the `phaseTokenUsage` type
  extension lives in Brief 02, not here. Briefs are sequential, but
  keeping the diffs disjoint per brief keeps reviewer context tight.

## Constraints

From ADR-015: pricing is hand-edited, no auto-fetch, no admin endpoint.
The seed JSON is operator-grade; if a price is wrong, you edit it and
redeploy. Don't introduce any "load from URL" or "fetch from S3"
machinery — that's an explicit non-goal.

From `design.md` → Contracts → Pricing: the `ModelPrice` shape
(`inputPer1M`, `outputPer1M`) is the contract. Don't widen it (no
`cachedTokenPer1M`, no per-tier pricing) without superseding ADR-015.

## Test expectations

Co-located `pricing/index.test.ts` covers the cases listed above.
Vitest is the runner. No mocks needed — these are pure functions
over a static JSON import. Aim for ≥ 90% line coverage on the file.

## Risks / pitfalls

- **JSON import attributes** — `with { type: 'json' }` is supported
  by Node 22 + `tsup`, but if the toolchain has trouble, fall back to
  the older `import x from './foo.json'` form (already enabled by
  `resolveJsonModule`). Don't use `require()` — `@autopod/shared` is
  pure ESM.
- **Short-alias drift** — if `profile.defaultModel` ever expands to
  more aliases (e.g. `'haiku-fast'`), they must be added here too.
  Document this in the JSON file as a top-level `"$comment"` key (JSON
  schema doesn't ban arbitrary keys, but the type cast filters them
  out at read time).
- **Floating-point summation** — `computeCost` returns plain `number`.
  Aggregation in Brief 03 sums many of these; sub-cent rounding errors
  are fine for display but don't try to round here. Round at format
  time in the desktop UI.

## Wrap-up

1. Run `/simplify` and address findings.
2. `npx pnpm --filter @autopod/shared build` — must pass.
3. `npx pnpm --filter @autopod/shared test` — must pass.
4. Commit and push.
