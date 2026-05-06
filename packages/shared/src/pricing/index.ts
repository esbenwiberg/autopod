import pricingData from './model-pricing.json' with { type: 'json' };

export interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> =
  pricingData as unknown as Record<string, ModelPrice>;

export function computeCost(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!model) return 0;
  const price = MODEL_PRICING[model];
  if (!price) return 0;
  return (inputTokens / 1_000_000) * price.inputPer1M + (outputTokens / 1_000_000) * price.outputPer1M;
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
