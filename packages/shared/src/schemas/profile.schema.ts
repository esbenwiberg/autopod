import { z } from 'zod';
import {
  actionPolicySchema,
  outputModeSchema,
  podOptionsSchema,
} from './action-definition.schema.js';
import {
  injectedClaudeMdSectionSchema,
  injectedMcpServerSchema,
  injectedSkillSchema,
} from './injection.schema.js';

// ---------------------------------------------------------------------------
// Model provider credentials schemas
// ---------------------------------------------------------------------------

export const modelProviderSchema = z.enum(['anthropic', 'max', 'foundry', 'copilot']);

const anthropicCredentialsSchema = z.object({
  provider: z.literal('anthropic'),
});

const maxCredentialsSchema = z.object({
  provider: z.literal('max'),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.string().min(1),
  clientId: z.string().optional(),
  // Required by claude 2.1.80+ — must be preserved through storage
  scopes: z.array(z.string()).optional(),
  subscriptionType: z.string().optional(),
  rateLimitTier: z.string().optional(),
});

const foundryCredentialsSchema = z.object({
  provider: z.literal('foundry'),
  endpoint: z.string().url(),
  projectId: z.string().min(1),
  apiKey: z.string().optional(),
});

const copilotCredentialsSchema = z.object({
  provider: z.literal('copilot'),
  token: z.string().min(1),
  model: z.string().optional(),
});

export const providerCredentialsSchema = z.discriminatedUnion('provider', [
  anthropicCredentialsSchema,
  maxCredentialsSchema,
  foundryCredentialsSchema,
  copilotCredentialsSchema,
]);

const pageAssertionSchema = z.object({
  selector: z.string().min(1),
  type: z.enum(['exists', 'text_contains', 'visible', 'count']),
  value: z.string().optional(),
});

const smokePageSchema = z.object({
  path: z.string().min(1).startsWith('/'),
  assertions: z.array(pageAssertionSchema).optional(),
});

// Validates hostnames and IPs used in network allowlists.
// Only alphanumerics, dots, and hyphens are permitted (plus a leading '*.' for wildcards).
// This prevents shell injection when hostnames are embedded in generated firewall scripts.
const SAFE_HOSTNAME_REGEX =
  /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$|^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const networkPolicySchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['allow-all', 'deny-all', 'restricted']).optional(),
  allowedHosts: z
    .array(
      z
        .string()
        .min(1)
        .regex(
          SAFE_HOSTNAME_REGEX,
          'Invalid hostname: only alphanumerics, dots, and hyphens are allowed (optionally prefixed with *. for wildcards)',
        ),
    )
    .default([]),
  replaceDefaults: z.boolean().optional(),
});

const registryTypeSchema = z.enum(['npm', 'nuget']);

const privateRegistrySchema = z.object({
  type: registryTypeSchema,
  url: z.string().url(),
  scope: z.string().startsWith('@').optional(),
});

export const pimActivationConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('group'),
    groupId: z.string().uuid('groupId must be a UUID'),
    displayName: z.string().min(1).max(128).optional(),
    duration: z.string().min(1).max(32).optional(),
    justification: z.string().min(1).max(500).optional(),
  }),
  z.object({
    type: z.literal('rbac_role'),
    scope: z.string().min(1).max(512),
    roleDefinitionId: z.string().uuid('roleDefinitionId must be a UUID'),
    displayName: z.string().min(1).max(128).optional(),
    duration: z.string().min(1).max(32).optional(),
    justification: z.string().min(1).max(500).optional(),
  }),
]);

const daggerSidecarConfigSchema = z.object({
  enabled: z.boolean(),
  // registry.dagger.io/engine@sha256:... — digest-pinned, no rolling tags.
  engineImageDigest: z
    .string()
    .min(1)
    .regex(/@sha256:[0-9a-f]{64}$/, 'engineImageDigest must be pinned by sha256 digest'),
  engineVersion: z.string().min(1).max(64),
  enginePort: z.number().int().min(1).max(65_535).optional(),
  memoryGb: z.number().positive().max(64).optional(),
  cpus: z.number().positive().max(32).optional(),
  storageGb: z.number().positive().max(200).optional(),
});

const sidecarsConfigSchema = z.object({
  dagger: daggerSidecarConfigSchema.optional(),
});

const testPipelineConfigSchema = z.object({
  enabled: z.boolean(),
  testRepo: z.string().url(),
  testPipelineId: z.number().int().positive(),
  rateLimitPerHour: z.number().int().min(1).max(1000).optional(),
  branchPrefix: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9\-_/]+\/$/, 'branchPrefix must end with `/` and be path-safe')
    .optional(),
});

const scanOutcomeSchema = z.enum(['block', 'warn', 'escalate']);

const checkpointPolicySchema = z.object({
  enabled: z.boolean(),
  scope: z.enum(['full', 'diff', 'auto']),
  onSecret: scanOutcomeSchema,
  onPii: scanOutcomeSchema,
  onInjection: scanOutcomeSchema,
});

const securityScanPolicySchema = z.object({
  detectors: z.object({
    secrets: z.object({ enabled: z.boolean() }),
    pii: z.object({
      enabled: z.boolean(),
      threshold: z.number().min(0).max(1).optional(),
    }),
    injection: z.object({
      enabled: z.boolean(),
      threshold: z.number().min(0).max(1).optional(),
    }),
  }),
  provisioning: checkpointPolicySchema,
  push: checkpointPolicySchema,
  alwaysScanPaths: z.array(z.string().min(1).max(256)).max(64).optional(),
});

const mergeableFieldSchema = z.enum([
  'smokePages',
  'customInstructions',
  'escalation',
  'mcpServers',
  'claudeMdSections',
  'skills',
  'privateRegistries',
]);

const mergeModeSchema = z.enum(['merge', 'replace']);

export const mergeStrategySchema = z.record(mergeableFieldSchema, mergeModeSchema).default({});

export const escalationConfigSchema = z.object({
  askHuman: z.boolean().default(true),
  askAi: z
    .object({
      enabled: z.boolean().default(false),
      model: z.string().default('sonnet'),
      maxCalls: z.number().int().min(0).max(50).default(5),
    })
    .default({}),
  advisor: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),
  autoPauseAfter: z.number().int().min(1).max(20).default(3),
  humanResponseTimeout: z.number().int().min(60).max(86_400).default(3600),
});

// For every catalog field the UI lets you override on a derived profile, the
// schema treats null as "inherit from parent". The `createProfileSchema`
// superRefine below still requires non-null values for fields that a base
// profile must carry (repoUrl, buildCommand, startCommand); everything else
// either has a safe default or is legitimately optional on base too.
const createProfileBaseSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9\-]+$/, 'Profile name must be lowercase alphanumeric with hyphens'),
  repoUrl: z.string().url().nullable().default(null),
  defaultBranch: z.string().nullable().default('main'),
  template: z
    .enum([
      'node22',
      'node22-pw',
      'dotnet9',
      'dotnet10',
      'dotnet10-go',
      'python312',
      'python-node',
      'go124',
      'go124-pw',
      'custom',
    ])
    .nullable()
    .default('node22'),
  buildCommand: z.string().min(1).nullable().default(null),
  startCommand: z.string().min(1).nullable().default(null),
  healthPath: z.string().nullable().default('/'),
  healthTimeout: z.number().int().min(10).max(600).nullable().default(120),
  // Nullable on the wire so derived profiles can signal "inherit from parent".
  // The daemon store normalizes null → [] at write time (see profile-store.ts).
  smokePages: z.array(smokePageSchema).nullable().default([]),
  maxValidationAttempts: z.number().int().min(1).max(10).nullable().default(3),
  defaultModel: z.string().nullable().default('opus'),
  defaultRuntime: z.enum(['claude', 'codex', 'copilot']).nullable().default('claude'),
  executionTarget: z.enum(['local', 'aci']).nullable().default('local'),
  customInstructions: z.string().max(50_000).nullable().default(null),
  escalation: escalationConfigSchema.nullable().default({}),
  extends: z.string().nullable().default(null),
  workerProfile: z.string().nullable().default(null),
  mcpServers: z.array(injectedMcpServerSchema).nullable().default([]),
  claudeMdSections: z.array(injectedClaudeMdSectionSchema).nullable().default([]),
  skills: z.array(injectedSkillSchema).nullable().default([]),
  networkPolicy: networkPolicySchema.nullable().default(null),
  actionPolicy: actionPolicySchema.nullable().default(null),
  pod: podOptionsSchema.nullable().default(null),
  outputMode: outputModeSchema.nullable().default('pr'),
  modelProvider: modelProviderSchema.nullable().default('anthropic'),
  providerCredentials: providerCredentialsSchema.nullable().default(null),
  testCommand: z.string().nullable().optional().default(null),
  buildTimeout: z.number().int().min(30).max(1800).nullable().default(300),
  testTimeout: z.number().int().min(30).max(3600).nullable().default(600),
  prProvider: z.enum(['github', 'ado']).nullable().default('github'),
  adoPat: z.string().min(1).nullable().default(null),
  githubPat: z.string().min(1).nullable().default(null),
  privateRegistries: z.array(privateRegistrySchema).nullable().default([]),
  registryPat: z.string().min(1).nullable().default(null),
  branchPrefix: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9\-_/]+$/, 'Branch prefix contains invalid characters')
    .nullable()
    .default('autopod/'),
  containerMemoryGb: z.number().min(0.5).max(64).nullable().default(null),
  tokenBudget: z.number().int().min(1000).nullable().default(null),
  tokenBudgetWarnAt: z.number().min(0.1).max(0.99).nullable().default(0.8),
  tokenBudgetPolicy: z.enum(['soft', 'hard']).nullable().default('soft'),
  maxBudgetExtensions: z.number().int().min(0).nullable().default(null),
  hasWebUi: z.boolean().nullable().default(true),
  issueWatcherEnabled: z.boolean().nullable().default(false),
  issueWatcherLabelPrefix: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9\-]+$/, 'Label prefix must be lowercase alphanumeric with hyphens')
    .nullable()
    .default('autopod'),
  pimActivations: z.array(pimActivationConfigSchema).nullable().default(null),
  mergeStrategy: mergeStrategySchema,
  sidecars: sidecarsConfigSchema.nullable().default(null),
  // trustedSource gates privileged sidecars. Safe default is false — privileged
  // sidecars won't be spawned until the profile author explicitly sets true.
  trustedSource: z.boolean().nullable().default(false),
  testPipeline: testPipelineConfigSchema.nullable().default(null),
  securityScan: securityScanPolicySchema.nullable().default(null),
});

// Every nullable field on the base schema except identity/metadata. On a
// derived profile, missing-on-the-wire must mean "inherit" (null), not
// "use the schema default" — otherwise the child would silently copy concrete
// values from the default and masquerade as an override on reopen.
const DERIVED_NULLABLE_FIELDS: readonly string[] = Object.keys(
  createProfileBaseSchema.shape,
).filter((k) => k !== 'name' && k !== 'extends' && k !== 'mergeStrategy');

// Base profiles (no `extends`) must carry the fields that cannot fall back to
// a parent — primarily repoUrl and the command fields. Other fields either
// have schema defaults (so they can't actually be null on create) or are
// legitimately optional.
export const createProfileSchema = z
  .preprocess((input) => {
    if (!input || typeof input !== 'object') return input;
    const data = input as Record<string, unknown>;
    // Base profile — keep Zod defaults so the row gets sensible values.
    if (data.extends == null) return data;
    // Derived profile — replace every missing nullable field with explicit
    // null so .nullable() preserves the intent instead of falling through
    // to .default(concreteValue).
    const result: Record<string, unknown> = { ...data };
    for (const key of DERIVED_NULLABLE_FIELDS) {
      if (!(key in result)) result[key] = null;
    }
    return result;
  }, createProfileBaseSchema)
  .superRefine((data, ctx) => {
    if (data.extends !== null) return;
    if (data.repoUrl === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repoUrl'],
        message: 'repoUrl is required on base profiles (extends is null)',
      });
    }
    if (data.buildCommand === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buildCommand'],
        message: 'buildCommand is required on base profiles (extends is null)',
      });
    }
    if (data.startCommand === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startCommand'],
        message: 'startCommand is required on base profiles (extends is null)',
      });
    }
  });

export const updateProfileSchema = createProfileBaseSchema.partial().omit({ name: true });
