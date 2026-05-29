import type { z } from 'zod';
import { LEGACY_CLAUDE_MODEL_ALIASES } from '../pricing/index.js';

export const canonicalModelIdMessage =
  'Use a canonical Claude model ID instead of legacy short aliases opus, sonnet, or haiku';

export function withCanonicalModelIdPolicy<T extends z.ZodString>(schema: T) {
  return schema.refine((model) => !LEGACY_CLAUDE_MODEL_ALIASES.has(model), canonicalModelIdMessage);
}
