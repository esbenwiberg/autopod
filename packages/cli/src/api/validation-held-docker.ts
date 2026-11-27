import { z } from 'zod';
import { cleanupResourceSchema } from './retained-cleanup.js';
export const heldDockerViewSchema = z
  .object({
    podId: z.string().min(1),
    state: z.enum(['eligible', 'blocked', 'pending', 'unknown', 'stopped']),
    generation: z.number().int().positive().optional(),
    binding: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    requestKey: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/)
      .optional(),
    resources: z.array(cleanupResourceSchema).optional(),
    observedStopped: z.boolean().optional(),
    blockers: z.array(
      z.object({ code: z.string(), message: z.string(), resourceId: z.string().optional() }),
    ),
    message: z.string().min(1),
  })
  .refine((v) =>
    v.state === 'blocked'
      ? v.blockers.length > 0
      : v.generation !== undefined &&
        v.binding !== undefined &&
        !!v.resources?.length &&
        (v.state === 'eligible' || v.requestKey !== undefined),
  );
