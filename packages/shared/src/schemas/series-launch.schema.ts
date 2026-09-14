import { z } from 'zod';
import { configurationIdSchema, savedLaunchSelectionSchema } from './launch-config.schema.js';
import { launchWorkSchema } from './launch-work.schema.js';

export const seriesLaunchRequestSchema = launchWorkSchema
  .pick({
    startBranch: true,
    baseBranch: true,
    specFiles: true,
    specContextFiles: true,
    seriesDescription: true,
    seriesDesign: true,
  })
  .extend({
    requestId: configurationIdSchema,
    seriesName: z.string().trim().min(1).max(128),
    launch: savedLaunchSelectionSchema,
    prMode: z.enum(['single', 'stacked', 'none']).default('single'),
    briefs: z
      .array(
        launchWorkSchema
          .pick({ contract: true, touches: true, doesNotTouch: true })
          .extend({
            title: z.string().trim().min(1).max(200),
            task: z.string().trim().min(1).max(100_000),
            dependsOn: z.array(z.string().min(1)).max(31).default([]),
            requireSidecars: z.array(configurationIdSchema).max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type SeriesLaunchRequest = z.input<typeof seriesLaunchRequestSchema>;
