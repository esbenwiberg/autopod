import { z } from 'zod';
import { partialPodOptionsSchema } from './action-definition.schema.js';
import { withCanonicalModelIdPolicy } from './model.schema.js';

const canonicalModelIdSchema = withCanonicalModelIdPolicy(z.string().min(1).max(32));

const branchNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9.\-_/]+$/, 'Branch name contains invalid characters')
  .refine((s) => !s.includes('..'), 'Branch name cannot contain ".."');

const specFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[^\\\0]+$/, 'Spec file path contains invalid characters')
    .refine((s) => !s.startsWith('/'), 'Spec file path must be relative')
    .refine((s) => !s.split('/').includes('..'), 'Spec file path cannot escape the repo'),
  content: z.string().max(1_000_000),
});

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
  kind: z.enum([
    'unit-test',
    'integration-test',
    'contract-test',
    'browser-test',
    'typecheck',
    'lint-rule',
    'smoke-script',
    'custom-command',
  ]),
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
    model: canonicalModelIdSchema.optional(),
    runtime: z.enum(['claude', 'codex']).optional(),
    executionTarget: z.enum(['local', 'aci']).optional(),
    branch: branchNameSchema.optional(),
    branchPrefix: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9.\-_/]+$/, 'Branch prefix contains invalid characters')
      .refine((s) => !s.includes('..'), 'Branch prefix cannot contain ".."')
      .optional(),
    skipValidation: z.boolean().optional(),
    contract: specContractSchema.optional(),
    options: partialPodOptionsSchema.optional(),
    outputMode: z.enum(['pr', 'artifact', 'workspace']).optional(),
    startBranch: branchNameSchema.optional(),
    baseBranch: branchNameSchema.optional(),
    specFiles: z.array(specFileSchema).max(200).optional(),
    linkedPodId: z.string().min(1).max(64).optional(),
    dependsOnPodId: z.string().min(1).max(64).optional(),
    dependsOnPodIds: z.array(z.string().min(1).max(64)).max(32).optional(),
    seriesId: z.string().min(1).max(64).optional(),
    seriesName: z.string().min(1).max(128).optional(),
    briefTitle: z.string().min(1).max(200).nullable().optional(),
    touches: z.array(z.string().min(1).max(500)).max(100).optional(),
    doesNotTouch: z.array(z.string().min(1).max(500)).max(100).optional(),
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

export const readinessStatusSchema = z.enum(['ready', 'needs_review', 'risky', 'waived']);

export const readinessAreaStatusSchema = z.enum([
  'ready',
  'needs_review',
  'risky',
  'waived',
  'not_applicable',
  'not_available',
]);

export const readinessAreaSchema = z.enum([
  'validation',
  'security',
  'actions',
  'network',
  'scope',
  'quality',
  'advisory_qa',
  'pr',
]);

export const readinessSourceRefSchema = z
  .object({
    kind: z.enum(['validation', 'work', 'logs', 'diff', 'pr', 'evidence', 'quality', 'event']),
    label: z.string().min(1).max(200),
    id: z.string().min(1).max(200).optional(),
    href: z.string().min(1).max(1000).optional(),
  })
  .passthrough();

export const readinessAreaReviewSchema = z
  .object({
    area: readinessAreaSchema,
    status: readinessAreaStatusSchema,
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(1000),
    sourceRefs: z.array(readinessSourceRefSchema).max(20),
  })
  .passthrough();

export const readinessFindingSchema = z
  .object({
    id: z.string().min(1).max(200),
    area: readinessAreaSchema,
    severity: z.enum(['info', 'warning', 'error']),
    title: z.string().min(1).max(200),
    detail: z.string().min(1).max(2000),
    sourceRefs: z.array(readinessSourceRefSchema).max(20),
  })
  .passthrough();

export const readinessApprovalSchema = z
  .object({
    approvedAt: z.string().min(1).max(64),
    approvedBy: z.string().min(1).max(200).optional(),
    statusAtApproval: readinessStatusSchema,
    scope: z.enum(['pod', 'series']),
    seriesId: z.string().min(1).max(128).optional(),
    reason: z.string().min(1).max(2000).optional(),
  })
  .passthrough();

export const readinessReviewSchema = z
  .object({
    status: readinessStatusSchema,
    summary: z.string().min(1).max(1000),
    computedAt: z.string().min(1).max(64),
    scope: z.literal('pod'),
    areas: z.array(readinessAreaReviewSchema).max(16),
    findings: z.array(readinessFindingSchema).max(100),
    approval: readinessApprovalSchema.nullable().optional(),
  })
  .passthrough();

export const nullableReadinessReviewSchema = readinessReviewSchema.nullable().optional();

export const podResponseSchema = z
  .object({
    readinessReview: nullableReadinessReviewSchema.default(null),
  })
  .passthrough();

export const sendMessageSchema = z.object({
  message: z.string().min(1).max(50_000),
});
