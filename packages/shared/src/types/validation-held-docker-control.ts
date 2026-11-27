import { z } from 'zod';
import type { RetainedCleanupBlocker, RetainedCleanupResource } from './retained-cleanup.js';

export const validationHeldStopRequestSchema = z.strictObject({
  requestKey: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
  expectedGeneration: z.number().int().positive(),
  expectedBinding: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.literal('stop-retain'),
  reason: z.string().trim().min(10).max(4000),
});
export type ValidationHeldStopRequest = z.infer<typeof validationHeldStopRequestSchema>;
export type ValidationHeldStopView = {
  podId: string;
  state: 'eligible' | 'blocked' | 'pending' | 'unknown' | 'stopped';
  generation?: number;
  binding?: string;
  requestKey?: string;
  resources?: RetainedCleanupResource[];
  observedStopped?: boolean;
  blockers: RetainedCleanupBlocker[];
  message: string;
};
