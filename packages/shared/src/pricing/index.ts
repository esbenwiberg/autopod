import pricingData from './model-pricing.json' with { type: 'json' };

export interface ModelPrice {
  inputPer1M: number;
  cachedInputPer1M?: number;
  outputPer1M: number;
}

// Strip the $comment documentation key so MODEL_PRICING contains only ModelPrice entries.
const { $comment: _comment, ...modelPrices } = pricingData as unknown as Record<string, ModelPrice>;
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = modelPrices;

/**
 * Maps short / legacy model aliases to their canonical MODEL_PRICING key so
 * analytics rollups don't bisect stats for what is the same model. See ADR-022.
 * Keep in sync with the alias keys in model-pricing.json (opus, sonnet, haiku).
 */
export const MODEL_CANONICAL: Readonly<Record<string, string>> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

/**
 * Resolve a raw model string to its canonical MODEL_PRICING key.
 * Returns null if the model is neither a direct MODEL_PRICING key nor a known alias.
 * MODEL_CANONICAL is checked first so short aliases (opus/sonnet/haiku) coalesce
 * to their full IDs even though MODEL_PRICING also carries those short names.
 */
export function canonicalModelKey(model: string | null | undefined): string | null {
  if (!model) return null;
  const aliased = MODEL_CANONICAL[model];
  if (aliased && aliased in MODEL_PRICING) return aliased;
  if (model in MODEL_PRICING) return model;
  return null;
}

export function computeCost(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): number {
  return computeCostWithCache(model, inputTokens, outputTokens, 0);
}

export function computeCostWithCache(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): number {
  if (!model) return 0;
  const price = MODEL_PRICING[model];
  if (!price) return 0;
  const cachedInput = price.cachedInputPer1M
    ? Math.min(Math.max(cachedInputTokens, 0), inputTokens)
    : 0;
  const uncachedInput = Math.max(inputTokens - cachedInput, 0);
  return (
    (uncachedInput / 1_000_000) * price.inputPer1M +
    (cachedInput / 1_000_000) * (price.cachedInputPer1M ?? price.inputPer1M) +
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
