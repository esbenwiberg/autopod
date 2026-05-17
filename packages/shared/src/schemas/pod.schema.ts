import { z } from 'zod';
import { partialPodOptionsSchema } from './action-definition.schema.js';

export const acTypeSchema = z.enum(['none', 'api', 'web', 'cmd']);
export const acPolaritySchema = z.enum(['expect-output', 'expect-no-output', 'exit-zero']);

const acBaseFields = {
  outcome: z.string().min(1).max(200),
  hint: z.string().max(500).optional(),
};

export const acDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ ...acBaseFields, type: z.literal('none') }),
  z.object({ ...acBaseFields, type: z.literal('api') }),
  z.object({ ...acBaseFields, type: z.literal('web') }),
  z.object({ ...acBaseFields, type: z.literal('cmd'), polarity: acPolaritySchema.optional() }),
]);

const contractScenarioFields: Record<string, z.ZodTypeAny> = {
  id: z.string().min(1).max(128),
  given: z.array(z.string().min(1)).min(1),
  when: z.array(z.string().min(1)).min(1),
};
const scenarioThenKey = 'then';
contractScenarioFields[scenarioThenKey] = z.array(z.string().min(1)).min(1);
const contractScenarioSchema = z.object(contractScenarioFields);

const requiredFactSchema = z.object({
  id: z.string().min(1).max(128),
  proves: z.array(z.string().min(1).max(128)).min(1),
  kind: z.string().min(1).max(64),
  artifact: z.object({
    path: z.string().min(1).max(500),
    change: z.enum(['create', 'update', 'touch']),
  }),
  command: z.string().min(1).max(1000),
});

const humanReviewSchema = z.object({
  id: z.string().min(1).max(128),
  covers: z.array(z.string().min(1).max(128)).min(1),
  criterion: z.string().min(1).max(500),
  reason: z.string().min(1).max(500),
});

export const specContractSchema = z.object({
  contractVersion: z.literal(1),
  title: z.string().min(1).max(200),
  dependsOn: z.array(z.string().min(1).max(128)),
  scenarios: z.array(contractScenarioSchema).min(1),
  requiredFacts: z.array(requiredFactSchema),
  humanReview: z.array(humanReviewSchema),
});

export const createPodRequestSchema = z
  .object({
    profileName: z.string().min(1).max(64),
    task: z.string().max(50_000),
    model: z.string().min(1).max(32).optional(),
    runtime: z.enum(['claude', 'codex']).optional(),
    executionTarget: z.enum(['local', 'aci']).optional(),
    branch: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9.\-_/]+$/, 'Branch name contains invalid characters')
      .refine((s) => !s.includes('..'), 'Branch name cannot contain ".."')
      .optional(),
    branchPrefix: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9.\-_/]+$/, 'Branch prefix contains invalid characters')
      .refine((s) => !s.includes('..'), 'Branch prefix cannot contain ".."')
      .optional(),
    skipValidation: z.boolean().optional(),
    acceptanceCriteria: z.array(acDefinitionSchema).optional(),
    contract: specContractSchema.optional(),
    options: partialPodOptionsSchema.optional(),
    outputMode: z.enum(['pr', 'artifact', 'workspace']).optional(),
    baseBranch: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9.\-_/]+$/, 'Branch name contains invalid characters')
      .refine((s) => !s.includes('..'), 'Branch name cannot contain ".."')
      .optional(),
    acFrom: z
      .string()
      .min(1)
      .max(500)
      .refine((p) => !p.startsWith('/') && !p.includes('..'), {
        message: 'acFrom must be a relative path without ".." segments',
      })
      .optional(),
    linkedPodId: z.string().min(1).max(64).optional(),
    dependsOnPodId: z.string().min(1).max(64).optional(),
    dependsOnPodIds: z.array(z.string().min(1).max(64)).max(32).optional(),
    seriesId: z.string().min(1).max(64).optional(),
    seriesName: z.string().min(1).max(128).optional(),
    pimGroups: z
      .array(
        z.object({
          groupId: z.string().uuid(),
          displayName: z.string().min(1).max(128).optional(),
          duration: z.string().min(1).max(32).optional(),
          justification: z.string().min(1).max(500).optional(),
        }),
      )
      .optional(),
    // Sidecars to spawn for this pod (e.g. ['dagger']). Each must correspond
    // to an enabled entry in `profile.sidecars`; privileged sidecars also
    // require the profile's `trustedSource` flag. Zod strips unknown fields,
    // so without this entry the field would be silently dropped by the POST
    // /pods handler even though the Pod type persists it.
    requireSidecars: z
      .array(
        z
          .string()
          .min(1)
          .max(32)
          .regex(/^[a-z][a-z0-9-]*$/, 'Sidecar names are lowercase kebab-case'),
      )
      .max(8)
      .optional(),
    // Read-only repos to mount at /repos/<name>/. Profile-picked entries
    // carry `sourceProfile` so the daemon can resolve auth from that profile;
    // ad-hoc entries omit it and clone unauthenticated. Zod strips unknown
    // fields, so omitting this entry would silently drop ref-repo posts.
    referenceRepos: z
      .array(
        z.object({
          url: z.string().url().max(500),
          sourceProfile: z.string().min(1).max(64).optional(),
        }),
      )
      .max(20)
      .optional(),
  })
  .refine(
    (data) => {
      const isInteractive =
        data.options?.agentMode === 'interactive' || data.outputMode === 'workspace';
      return isInteractive || data.task.length > 0;
    },
    { message: 'task: String must contain at least 1 character(s)', path: ['task'] },
  );

export const podStatusSchema = z.enum([
  'queued',
  'provisioning',
  'running',
  'awaiting_input',
  'validating',
  'validated',
  'failed',
  'review_required',
  'approved',
  'merging',
  'merge_pending',
  'complete',
  'paused',
  'handoff',
  'killing',
  'killed',
]);

export const sendMessageSchema = z.object({
  message: z.string().min(1).max(50_000),
});
