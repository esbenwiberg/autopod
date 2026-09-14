import { z } from 'zod';
import { configurationIdSchema, savedLaunchSelectionSchema } from './launch-config.schema.js';

const repositoryLaunch = savedLaunchSelectionSchema.refine(
  (value): value is Extract<z.infer<typeof savedLaunchSelectionSchema>, { repositoryId: string }> =>
    'repositoryId' in value && !!value.repositoryId,
  'Issue watchers require an enrolled repository',
);
const suffix = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const issueWatcherBindingSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    enabled: z.boolean(),
    labelPrefix: suffix.default('autopod'),
    launch: repositoryLaunch,
    /** Explicit named label routes. Issue text cannot select an arbitrary profile or repository. */
    targets: z.record(suffix, repositoryLaunch).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [label, target] of Object.entries(value.targets)) {
      if (label === 'artifact' || label === 'in-progress' || label === 'done' || label === 'failed')
        context.addIssue({
          code: 'custom',
          path: ['targets', label],
          message: 'Reserved watcher label',
        });
      if (target.repositoryId !== value.launch.repositoryId)
        context.addIssue({
          code: 'custom',
          path: ['targets', label],
          message: 'Watcher label routes must use the watched repository',
        });
    }
  });
export const writeIssueWatcherBindingSchema = z
  .object({
    id: configurationIdSchema.optional(),
    expectedRevision: z.number().int().positive().optional(),
    payload: issueWatcherBindingSchema,
  })
  .strict();
export type IssueWatcherBindingPayload = z.infer<typeof issueWatcherBindingSchema>;
export interface IssueWatcherBinding {
  id: string;
  revision: number;
  ownerUserId: string;
  payload: IssueWatcherBindingPayload;
  createdAt: string;
  updatedAt: string;
}
