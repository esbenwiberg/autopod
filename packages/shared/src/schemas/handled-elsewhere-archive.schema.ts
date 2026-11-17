import { z } from 'zod';

/** Operator visibility disposition, never evidence of termination or native delivery. */
export const handledElsewhereArchiveRequestSchema = z
  .object({
    expectedGeneration: z.number().int().positive(),
    expectedStatus: z.enum([
      'validated',
      'paused',
      'review_required',
      'failed',
      'complete',
      'killed',
    ]),
    reason: z.string().trim().min(10).max(2000),
    reference: z
      .string()
      .max(1024)
      .url()
      .regex(
        /^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/,
        'Reference must not contain credentials, query or fragment',
      ),
    retainResources: z.literal(true),
    acknowledgement: z.literal('visibility-only-unknown-execution-retained'),
  })
  .strict();

export type HandledElsewhereArchiveRequest = z.infer<typeof handledElsewhereArchiveRequestSchema>;
