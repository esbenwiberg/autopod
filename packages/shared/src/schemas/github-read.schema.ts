import { z } from 'zod';
const repositoryId = z.string().regex(/^[1-9][0-9]*$/);
const identifier = z.number().int().positive();
const ref = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes('..') && !/\s/.test(value));
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      value.split('/').every((part) => part !== '..' && part !== '.'),
  );
const base = z.object({ repositoryId });
const page = base.extend({
  page: z.number().int().min(1).max(1000).default(1),
  perPage: z.number().int().min(1).max(100).default(30),
});
export const githubReadSchema = z.discriminatedUnion('resource', [
  base.extend({ resource: z.literal('code.file'), path, ref }).strict(),
  base.extend({ resource: z.literal('code.tree'), ref }).strict(),
  base.extend({ resource: z.literal('code.commit'), ref }).strict(),
  page
    .extend({
      resource: z.literal('issues.list'),
      state: z.enum(['open', 'closed', 'all']).default('open'),
    })
    .strict(),
  base.extend({ resource: z.literal('issues.get'), number: identifier }).strict(),
  page.extend({ resource: z.literal('issues.comments'), number: identifier }).strict(),
  page
    .extend({
      resource: z.literal('prs.list'),
      state: z.enum(['open', 'closed', 'all']).default('open'),
    })
    .strict(),
  base.extend({ resource: z.literal('prs.get'), number: identifier }).strict(),
  page.extend({ resource: z.literal('prs.files'), number: identifier }).strict(),
  page.extend({ resource: z.literal('prs.reviews'), number: identifier }).strict(),
  page.extend({ resource: z.literal('prs.comments'), number: identifier }).strict(),
  page.extend({ resource: z.literal('actions.workflows') }).strict(),
  page.extend({ resource: z.literal('actions.runs'), workflowId: identifier.optional() }).strict(),
  base.extend({ resource: z.literal('actions.run'), runId: identifier }).strict(),
  page.extend({ resource: z.literal('actions.jobs'), runId: identifier }).strict(),
  base.extend({ resource: z.literal('actions.job'), jobId: identifier }).strict(),
  base.extend({ resource: z.literal('actions.jobLogs'), jobId: identifier }).strict(),
  base.extend({ resource: z.literal('actions.runLogs'), runId: identifier }).strict(),
  page.extend({ resource: z.literal('actions.artifacts'), runId: identifier.optional() }).strict(),
  base.extend({ resource: z.literal('actions.artifact'), artifactId: identifier }).strict(),
]);
export type GitHubReadRequest = z.infer<typeof githubReadSchema>;
