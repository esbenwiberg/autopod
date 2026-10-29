import { z } from 'zod';
import { createPodRequestSchema } from './pod.schema.js';

/** Task-specific inputs survive composition; presets cannot silently replace the work contract. */
// This projection intentionally selects field schemas, not whole-pod cross-field rules
// (the previous Zod 3 innerType() projection did the same); final pod admission checks those.
export const launchWorkSchema = z
  .object(createPodRequestSchema.shape)
  .pick({
    intentionalRerun: true,
    branch: true,
    startBranch: true,
    baseBranch: true,
    contract: true,
    handoffInstructions: true,
    specFiles: true,
    specContextFiles: true,
    linkedPodId: true,
    dependsOnPodIds: true,
    seriesId: true,
    seriesName: true,
    briefTitle: true,
    touches: true,
    doesNotTouch: true,
  })
  .extend({
    analysis: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('history'),
            scope: z.enum(['repository', 'all']).default('repository'),
            since: z.string().datetime().optional(),
            limit: z.number().int().min(1).max(1000).default(100),
            failuresOnly: z.boolean().default(false),
          })
          .strict(),
        z.object({ kind: z.literal('memory') }).strict(),
      ])
      .optional(),
    seriesDescription: z.string().max(100_000).nullable().optional(),
    seriesDesign: z.string().max(100_000).nullable().optional(),
    prMode: z.enum(['single', 'stacked', 'none']).nullable().optional(),
    waitForMerge: z.boolean().optional(),
  })
  .strict();
