# Handover — legislative-whippet (Brief 01: Pricing Seam)

## What was built

Added the model pricing catalog and cost helpers to `@autopod/shared` per ADR-015.
Three new files, one index.ts change:

- `packages/shared/src/pricing/model-pricing.json` — bundled price catalog (9 models + short aliases + `$comment` docs key)
- `packages/shared/src/pricing/index.ts` — `ModelPrice` interface, `MODEL_PRICING` const, `computeCost()`, `effectiveCostUsd()`
- `packages/shared/src/pricing/index.test.ts` — 11 tests covering all specified cases; all pass
- `packages/shared/src/index.ts` — added `export * from './pricing/index.js'`

Build and tests pass (`npx pnpm --filter @autopod/shared build` + `test`).

## Deviations from brief

- The type cast in `pricing/index.ts` uses `as unknown as Record<string, ModelPrice>` instead of the brief's `as Record<string, ModelPrice>`. This is required because the `$comment` key in the JSON has type `string`, which is incompatible with `ModelPrice` — TypeScript's DTS build rejected the direct cast. The double cast via `unknown` is the correct fix; `$comment` is filtered out at read time since no caller iterates all keys.

## Interfaces and contracts downstream pods must know

### `computeCost(model, inputTokens, outputTokens): number`
- Returns `0` for `null` model or unknown model string (no throw, no warn — by design per brief).
- Division is by `1_000_000`; no rounding — round at display time in desktop.

### `effectiveCostUsd(pod): number`
- `pod.costUsd > 0` → returns it directly (Claude path)
- `pod.costUsd === 0` → falls back to `computeCost(pod.model, pod.inputTokens, pod.outputTokens)`
- The `pod` parameter shape is `{ model: string | null; inputTokens: number; outputTokens: number; costUsd: number }` — Brief 03 will pass rows from the `pods` table that already have these columns.

### `MODEL_PRICING`
- Module-level `Readonly<Record<string, ModelPrice>>` — safe to read without null-checking the module itself.
- The `$comment` key exists in the JSON but is excluded from the type; any code iterating entries should filter non-object values.

## Files Brief 02 must NOT modify

- `packages/shared/src/pricing/model-pricing.json` — pricing JSON is hand-edited per ADR-015; do not touch in Brief 02.
- `packages/shared/src/pricing/index.ts` — Brief 02 only extends `pod.ts` types; pricing helpers are not touched until Brief 03.
- `packages/shared/src/pricing/index.test.ts` — no changes expected in Brief 02.

## Constraints and landmines

- **JSON import attribute syntax** (`with { type: 'json' }`): works with tsup 8.5.1 + Node 22. If Brief 03 or later hits a bundler that rejects this syntax, the fallback is to drop the `with { type: 'json' }` clause — `resolveJsonModule: true` in `tsconfig.base.json` makes the bare import form work too.
- **`$comment` in JSON**: filtered by the type cast; never shows up as a `ModelPrice`. Do not rely on `Object.keys(MODEL_PRICING)` returning only model IDs without filtering — the key will be there at runtime.
- **Short aliases**: `opus`, `sonnet`, `haiku` map to the same prices as their full-ID counterparts. If `profile.defaultModel` gains new aliases they must be added to the JSON.
