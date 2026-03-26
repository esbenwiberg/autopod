import { z } from 'zod';
import { actionPolicySchema, outputModeSchema } from './action-definition.schema.js';
import { injectedClaudeMdSectionSchema, injectedMcpServerSchema } from './injection.schema.js';

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

const networkPolicySchema = z.object({
  enabled: z.boolean(),
  allowedHosts: z.array(z.string().min(1)).default([]),
  replaceDefaults: z.boolean().optional(),
});

const escalationConfigSchema = z.object({
  askHuman: z.boolean().default(true),
  askAi: z
    .object({
      enabled: z.boolean().default(false),
      model: z.string().default('sonnet'),
      maxCalls: z.number().int().min(0).max(50).default(5),
    })
    .default({}),
  autoPauseAfter: z.number().int().min(1).max(20).default(3),
  humanResponseTimeout: z.number().int().min(60).max(86_400).default(3600),
});

export const createProfileSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9\-]+$/, 'Profile name must be lowercase alphanumeric with hyphens'),
  repoUrl: z.string().url(),
  defaultBranch: z.string().default('main'),
  template: z.enum(['node22', 'node22-pw', 'dotnet9', 'dotnet10', 'python312', 'custom']).default('node22'),
  buildCommand: z.string().min(1),
  startCommand: z.string().min(1),
  healthPath: z.string().default('/'),
  healthTimeout: z.number().int().min(10).max(600).default(120),
  smokePages: z.array(smokePageSchema).default([]),
  maxValidationAttempts: z.number().int().min(1).max(10).default(3),
  defaultModel: z.string().default('opus'),
  defaultRuntime: z.enum(['claude', 'codex', 'copilot']).default('claude'),
  executionTarget: z.enum(['local', 'aci']).default('local'),
  customInstructions: z.string().max(50_000).nullable().default(null),
  escalation: escalationConfigSchema.default({}),
  extends: z.string().nullable().default(null),
  mcpServers: z.array(injectedMcpServerSchema).default([]),
  claudeMdSections: z.array(injectedClaudeMdSectionSchema).default([]),
  networkPolicy: networkPolicySchema.nullable().default(null),
  actionPolicy: actionPolicySchema.nullable().default(null),
  outputMode: outputModeSchema.default('pr'),
  modelProvider: modelProviderSchema.default('anthropic'),
  providerCredentials: providerCredentialsSchema.nullable().default(null),
  testCommand: z.string().nullable().optional().default(null),
  prProvider: z.enum(['github', 'ado']).default('github'),
  adoPat: z.string().min(1).nullable().default(null),
});

export const updateProfileSchema = createProfileSchema.partial().omit({ name: true });
