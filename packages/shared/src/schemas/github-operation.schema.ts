import { z } from 'zod';
import { configurationIdSchema } from './launch-config.schema.js';

const base = z.object({
  repositoryId: z.string().regex(/^[1-9][0-9]*$/),
  operationKey: configurationIdSchema,
});
const number = z.number().int().positive();
const body = z.string().min(1).max(60_000);
const title = z.string().trim().min(1).max(256);
const labels = z.array(z.string().min(1).max(50)).max(100);
export const githubMutationSchema = z
  .discriminatedUnion('operation', [
    base
      .extend({
        operation: z.literal('issues.create'),
        title,
        body: body.optional(),
      })
      .strict(),
    base
      .extend({
        operation: z.literal('issues.edit'),
        issueNumber: number,
        title: title.optional(),
        body: body.optional(),
      })
      .strict(),
    base.extend({ operation: z.literal('issues.close'), issueNumber: number }).strict(),
    base.extend({ operation: z.literal('issues.labels'), issueNumber: number, labels }).strict(),
    base.extend({ operation: z.literal('issues.comment'), issueNumber: number, body }).strict(),
    base.extend({ operation: z.literal('prs.comment'), issueNumber: number, body }).strict(),
    base
      .extend({
        operation: z.literal('workflows.dispatch'),
        workflowId: z.string().regex(/^[1-9][0-9]*$/),
        branch: z
          .string()
          .min(1)
          .max(255)
          .refine(
            (s) => !s.startsWith('refs/') && !s.includes('*') && !s.includes('..') && !/\s/.test(s),
          ),
        inputs: z.record(z.string().max(60_000)).default({}),
      })
      .strict(),
    base.extend({ operation: z.literal('runs.rerun'), runId: number }).strict(),
    base.extend({ operation: z.literal('runs.cancel'), runId: number }).strict(),
  ])
  .superRefine((v, ctx) => {
    if (v.operation === 'issues.edit' && v.title === undefined && v.body === undefined)
      ctx.addIssue({ code: 'custom', message: 'Choose an issue field to edit' });
  });
export type GitHubMutation = z.infer<typeof githubMutationSchema>;
