import { z } from 'zod';
import { launchWorkSchema } from './launch-work.schema.js';
import { reasoningEffortSchema, updateProfileSchema } from './profile.schema.js';
import { serviceAccessSchema } from './service-access.schema.js';

export const configurationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const name = z.string().trim().min(1).max(128);
const toolName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const text = z.string().max(50_000);
const id = configurationIdSchema;
const uniqueIds = z
  .array(id)
  .max(256)
  .refine((v) => new Set(v).size === v.length, 'Duplicate IDs');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const secretRef = z.object({ secretId: id }).strict();
export const configurationValueSchema = z.union([
  z.object({ value: z.string() }).strict(),
  secretRef,
]);
const values = z.record(configurationValueSchema);
const command = z.string().min(1).max(50_000).nullable();
const timeout = z.number().int().positive().max(86_400);
export const configurationUrlSchema = z
  .string()
  .url()
  .regex(
    /^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/,
    'Use an HTTP(S) URL without credentials, query or fragment',
  );
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (s) => !s.startsWith('/') && !s.includes('\\') && !s.split('/').includes('..'),
    'Path must stay inside the workspace',
  );

export const repositorySetupSchema = z
  .object({
    id,
    name,
    defaultBranch: z.string().min(1).default('main'),
    buildCommand: command.default(null),
    startCommand: command.default(null),
    buildWorkDir: relativePath.nullable().default(null),
    testCommand: command.default(null),
    validationSetupCommand: command.default(null),
    lintCommand: command.default(null),
    sastCommand: command.default(null),
    prepareCommand: command.default(null),
    healthPath: z.string().startsWith('/').nullable().default('/'),
    healthTimeout: timeout.default(120),
    smokePages: z
      .array(
        z
          .object({
            path: z.string().startsWith('/'),
            assertions: z
              .array(
                z
                  .object({
                    selector: z.string().min(1),
                    type: z.enum(['exists', 'text_contains', 'visible', 'count']),
                    value: z.string().optional(),
                  })
                  .strict(),
              )
              .optional(),
          })
          .strict(),
      )
      .default([]),
    buildEnv: values.default({}),
    buildTimeout: timeout.default(300),
    testTimeout: timeout.default(600),
    lintTimeout: timeout.default(120),
    sastTimeout: timeout.default(300),
    hasWebUi: z.boolean().default(true),
    integrations: z
      .object({
        prProvider: z.enum(['github', 'ado']).default('github'),
        privateRegistries: z
          .array(
            z
              .object({
                type: z.enum(['npm', 'nuget']),
                url: configurationUrlSchema,
                scope: z.string().startsWith('@').optional(),
                credential: secretRef.nullable().default(null),
                expiresAt: z.string().date().nullable().default(null),
              })
              .strict(),
          )
          .default([]),
        serviceAccess: serviceAccessSchema.default([]),
        deployment: z
          .object({
            enabled: z.boolean(),
            source: z.literal('published-default').default('published-default'),
            targetId: id.optional(),
            env: values,
            allowedScripts: z.array(relativePath).optional(),
          })
          .strict()
          .nullable()
          .default(null),
      })
      .strict()
      .default({}),
  })
  .strict();

export const repositoryConfigSchema = z
  .object({
    provider: z.enum(['github', 'ado', 'git']),
    remote: configurationUrlSchema,
    providerRepositoryId: id.nullable().default(null),
    setups: z.array(repositorySetupSchema).min(1).max(128),
    defaultSetupId: id,
    usualProfileId: id.nullable().default(null),
    // Authority is controlled by the repository editor, never launch overrides.
    trustedSetupIds: uniqueIds.default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = v.setups.map((s) => s.id);
    if (
      new Set(ids).size !== ids.length ||
      !ids.includes(v.defaultSetupId) ||
      v.trustedSetupIds.some((s) => !ids.includes(s))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Repository setup identities are invalid' });
    }
  });

export const environmentPresetSchema = z
  .object({
    template: updateProfileSchema.shape.template.unwrap().removeDefault().unwrap(),
    baseImage: z.string().min(1).nullable().default(null),
    tools: z.array(z.object({ name, version: z.string().min(1) }).strict()).default([]),
    prepareCommands: z.array(z.string().min(1)).default([]),
    capabilities: uniqueIds.default([]),
    sidecars: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(63)
              .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
            type: z.enum(['dagger-engine', 'postgres', 'redis']),
            image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/),
            version: z.string().min(1),
            startup: z.enum(['disabled', 'on-demand', 'always']).default('on-demand'),
            port: z.number().int().min(1).max(65535),
            healthTimeoutMs: z.number().int().positive().default(60_000),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const agentTargetSchema = z
  .object({
    providerAccountId: id,
    runtime: z.enum(['claude', 'codex', 'copilot', 'pi']),
    model: z.string().min(1).max(256),
    reasoningEffort: reasoningEffortSchema.default('auto'),
  })
  .strict();
export const agentRouteSchema = agentTargetSchema
  .extend({
    failover: z.array(agentTargetSchema).max(16).default([]),
    maxHops: z.number().int().min(0).max(16).default(0),
  })
  .strict();
export const aiPresetSchema = z
  .object({
    main: agentRouteSchema,
    reviewer: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('follow-main') }).strict(),
        z.object({ mode: z.literal('independent'), route: agentRouteSchema }).strict(),
      ])
      .default({ mode: 'follow-main' }),
  })
  .strict();

export const launchValidationPhaseSchema = z.enum([
  'setup',
  'lint',
  'sast',
  'build',
  'test',
  'health',
  'pages',
  'facts',
  'review',
  'advisory',
]);
export const workflowPresetSchema = z
  .object({
    agentMode: z.enum(['auto', 'interactive']).default('auto'),
    intent: z.enum(['task', 'goal']).default('task'),
    output: z.enum(['pr', 'branch', 'artifact', 'none']).default('pr'),
    validationPhases: z
      .array(launchValidationPhaseSchema)
      .default(['setup', 'build', 'test', 'review']),
    advisoryBrowserQaEnabled: z.boolean().default(false),
    promotable: z.boolean().default(false),
    completion: z.enum(['approval', 'deliver', 'merge']).default('approval'),
    maxValidationAttempts: z.number().int().min(1).max(10).default(3),
    mergePollIntervalSec: z.number().int().min(5).max(3600).default(60),
    preflightConflictPolicy: z.enum(['warn', 'block']).default('warn'),
    branchPrefix: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9._/-]+$/)
      .refine((s) => !s.includes('..'))
      .default('autopod/'),
    tokenBudget: z.number().int().positive().nullable().default(null),
    reviewerTokenBudget: z.number().int().positive().nullable().default(null),
    tokenBudgetWarnAt: z.number().min(0.1).max(0.99).default(0.8),
    tokenBudgetPolicy: z.enum(['soft', 'hard']).default('soft'),
    maxBudgetExtensions: z.number().int().nonnegative().nullable().default(null),
    escalation: updateProfileSchema.shape.escalation.default(null),
    agentDonePrompt: text.nullable().default(null),
    securityScan: updateProfileSchema.shape.securityScan.default(null),
  })
  .strict();

export const githubOperationSchema = z.enum([
  'code.read',
  'issues.read',
  'prs.read',
  'actions.read',
  'issues.create',
  'issues.edit',
  'issues.close',
  'issues.labels',
  'issues.comment',
  'prs.comment',
  'workflows.dispatch',
  'runs.rerun',
  'runs.cancel',
]);
export const githubAccessRuleSchema = z
  .object({
    id,
    repositories: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('current') }).strict(),
      z.object({ mode: z.literal('selected'), repositoryIds: uniqueIds }).strict(),
      z
        .object({
          mode: z.literal('owner'),
          ownerId: id,
          ownerLogin: name,
          selection: z.union([
            z.object({ mode: z.literal('all') }).strict(),
            z.object({ mode: z.literal('selected'), repositoryIds: uniqueIds }).strict(),
          ]),
        })
        .strict(),
    ]),
    operations: z.array(githubOperationSchema),
    workflows: z
      .union([
        z.object({ mode: z.literal('all') }).strict(),
        z
          .object({
            mode: z.literal('selected'),
            files: z.array(
              z
                .object({
                  repositoryId: id,
                  path: z.string().regex(/^\.github\/workflows\/[^/]+\.ya?ml$/),
                  workflowId: id.optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      ])
      .default({ mode: 'selected', files: [] }),
    branches: z
      .union([
        z.object({ mode: z.literal('all') }).strict(),
        z
          .object({
            mode: z.literal('selected'),
            names: z.array(
              z
                .string()
                .min(1)
                .refine((s) => !s.includes('*')),
            ),
          })
          .strict(),
      ])
      .default({ mode: 'selected', names: [] }),
  })
  .strict();
export const githubAccessPresetSchema = z
  .object({ rules: z.array(githubAccessRuleSchema).max(128) })
  .strict();

export const toolPackSchema = z
  .object({
    instructions: z.array(z.object({ heading: name, content: text }).strict()).default([]),
    skills: z
      .array(
        z
          .object({
            name: toolName,
            description: z.string().max(500).optional(),
            source: z.discriminatedUnion('type', [
              z.object({ type: z.literal('local'), path: z.string().min(1) }).strict(),
              z
                .object({
                  type: z.literal('github'),
                  repositoryId: id,
                  path: relativePath,
                  ref: z.string().min(1),
                })
                .strict(),
              z.object({ type: z.literal('builtin') }).strict(),
              z.object({ type: z.literal('inline'), content: text }).strict(),
            ]),
          })
          .strict(),
      )
      .default([]),
    mcpServers: z
      .array(
        z
          .object({
            name: toolName,
            transport: z.discriminatedUnion('type', [
              z
                .object({
                  type: z.literal('http'),
                  url: configurationUrlSchema,
                  headers: values.default({}),
                })
                .strict(),
              z
                .object({
                  type: z.literal('stdio'),
                  command: z.string().min(1),
                  args: z.array(z.string()),
                  env: values.default({}),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .default([]),
    requiredCapabilities: uniqueIds.default([]),
  })
  .strict();

export const pimSelectionSchema = z
  .object({
    type: z.enum(['group', 'azure-role', 'directory-role']),
    tenantId: id,
    principalId: id,
    eligibilityId: id,
    roleId: id,
    scope: z.string().min(1),
    displayName: name,
    timing: z.enum(['startup', 'when-needed']).default('when-needed'),
    duration: z
      .string()
      .regex(/^PT(?:[1-9][0-9]*H|[1-9][0-9]*M)$/)
      .default('PT1H'),
    justification: z.string().trim().min(1).max(500),
  })
  .strict();
export const allocationSchema = z
  .object({
    memoryGb: z.number().positive().max(1024).nullable().default(null),
    cpus: z.number().positive().max(256).nullable().default(null),
    storageGb: z.number().positive().max(1024).nullable().default(null),
  })
  .strict();
export const executionSettingsSchema = z
  .object({
    target: z.enum(['local', 'sandbox']).default('local'),
    main: allocationSchema.default({}),
    sidecars: z.record(allocationSchema).default({}),
    networkPolicy: updateProfileSchema.shape.networkPolicy.default(null),
  })
  .strict();
export const launchProfileSchema = z
  .object({
    environmentId: id,
    aiId: id,
    workflowId: id,
    githubAccessId: id.nullable().default(null),
    toolPackIds: uniqueIds.default([]),
    requiredSidecarIds: uniqueIds.default([]),
    execution: executionSettingsSchema.default({}),
    pim: z.array(pimSelectionSchema).default([]),
    workerProfileId: id.nullable().default(null),
  })
  .strict();

export const configurationPayloadSchemas = {
  repository: repositoryConfigSchema,
  environment: environmentPresetSchema,
  ai: aiPresetSchema,
  workflow: workflowPresetSchema,
  githubAccess: githubAccessPresetSchema,
  toolPack: toolPackSchema,
  profile: launchProfileSchema,
} as const;
export const configurationKindSchema = z.enum([
  'repository',
  'environment',
  'ai',
  'workflow',
  'githubAccess',
  'toolPack',
  'profile',
]);
export const configurationRevisionSchema = z
  .object({
    id,
    kind: configurationKindSchema,
    name,
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    archived: z.boolean(),
  })
  .strict();

export const launchOverridesSchema = z
  .object({
    repositorySetup: repositorySetupSchema
      .omit({ id: true, name: true, integrations: true })
      .partial()
      .strict(),
    environment: environmentPresetSchema.partial().strict(),
    ai: aiPresetSchema.partial().strict(),
    workflow: workflowPresetSchema.partial().strict(),
    githubAccess: githubAccessPresetSchema.partial().strict(),
    execution: executionSettingsSchema
      .partial()
      .extend({ main: allocationSchema.partial().optional() })
      .strict(),
    pim: z.array(pimSelectionSchema),
    toolPacks: z.array(toolPackSchema),
  })
  .partial()
  .strict();
const launchOptions = z
  .object({
    profileId: id.optional(),
    source: z
      .object({ podId: id, digest, configuration: z.enum(['original', 'current', 'worker']) })
      .strict()
      .optional(),
    task: z.string().trim().min(1).max(100_000),
    work: launchWorkSchema.optional(),
    intent: z.enum(['task', 'goal']).optional(),
    requiredSidecarIds: uniqueIds.optional(),
    selections: z
      .object({
        environmentId: id.optional(),
        aiId: id.optional(),
        workflowId: id.optional(),
        githubAccessId: id.nullable().optional(),
        toolPackIds: uniqueIds.optional(),
      })
      .strict()
      .optional(),
    overrides: launchOverridesSchema.optional(),
    referenceRepositories: z
      .array(
        z.object({ repositoryId: id, ref: z.string().min(1), access: z.literal('read') }).strict(),
      )
      .max(16)
      .default([]),
    expectedDigest: digest.optional(),
    requestId: id.optional(),
  })
  .strict();
/** Reusable selection for scheduled callers. Task and retry identity belong to each run. */
const savedLaunchOptions = launchOptions.omit({
  source: true,
  task: true,
  work: true,
  expectedDigest: true,
  requestId: true,
});
export const savedLaunchSelectionSchema = z.union([
  savedLaunchOptions.extend({ repositoryId: id, repositorySetupId: id.optional() }).strict(),
  savedLaunchOptions.extend({ emptyWorkspace: z.literal(true), profileId: id }).strict(),
]);
export const launchRequestSchema = z
  .union([
    launchOptions.extend({ repositoryId: id, repositorySetupId: id.optional() }).strict(),
    launchOptions.extend({ emptyWorkspace: z.literal(true), profileId: id }).strict(),
  ])
  .superRefine((v, ctx) => {
    if (v.intent === 'goal' && v.task.length > 4000) {
      ctx.addIssue({
        code: 'custom',
        path: ['task'],
        message: 'Goal objective exceeds 4000 characters',
      });
    }
  });
