import { z } from 'zod';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_REVIEWER_MODEL } from '../pricing/index.js';
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
import { withCanonicalModelIdPolicy } from './model.schema.js';
import {
  providerAccountIdSchema,
  providerFailoverPolicySchema,
} from './provider-account.schema.js';

// ---------------------------------------------------------------------------
// Model provider credentials schemas
// ---------------------------------------------------------------------------

export const modelProviderSchema = z.enum([
  'anthropic',
  'max',
  'openai',
  'foundry',
  'copilot',
  'openrouter',
  'pi',
]);

const anthropicCredentialsSchema = z.object({
  provider: z.literal('anthropic'),
});

const openAiCredentialsSchema = z.object({
  provider: z.literal('openai'),
  authMode: z.literal('chatgpt').optional(),
  authJson: z.string().min(1).optional(),
});

const maxRefreshCredentialsSchema = z.object({
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

const maxSetupTokenCredentialsSchema = z.object({
  provider: z.literal('max'),
  authMode: z.literal('setup-token').optional(),
  oauthToken: z.string().min(1),
});

const maxCredentialsSchema = z.union([maxRefreshCredentialsSchema, maxSetupTokenCredentialsSchema]);

const foundryCredentialsSchema = z.object({
  provider: z.literal('foundry'),
  endpoint: z.string().url(),
  projectId: z.string().min(1),
  apiKey: z.string().optional(),
  apiSurface: z.enum(['anthropic', 'openai']).optional(),
  apiVersion: z.string().min(1).optional(),
});

const copilotCredentialsSchema = z.object({
  provider: z.literal('copilot'),
  token: z.string().min(1),
  model: z.string().optional(),
});

const openRouterCredentialsSchema = z.object({
  provider: z.literal('openrouter'),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

const piOAuthCredentialsSchema = z.object({
  provider: z.literal('pi'),
  providerId: z.enum(['anthropic', 'openai-codex', 'github-copilot']),
  credential: z
    .record(z.unknown())
    .refine(
      (credential) =>
        ['access', 'accessToken', 'token'].some(
          (field) => typeof credential[field] === 'string' && credential[field].trim().length > 0,
        ),
      'Pi credential must contain a non-empty access token',
    ),
});

export const providerCredentialsSchema = z.union([
  anthropicCredentialsSchema,
  openAiCredentialsSchema,
  maxCredentialsSchema,
  foundryCredentialsSchema,
  copilotCredentialsSchema,
  openRouterCredentialsSchema,
  piOAuthCredentialsSchema,
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

const canonicalModelIdSchema = withCanonicalModelIdPolicy(z.string());

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
  allowPackageManagers: z.boolean().optional(),
});

const registryTypeSchema = z.enum(['npm', 'nuget']);

const privateRegistrySchema = z.object({
  type: registryTypeSchema,
  url: z.string().url(),
  scope: z.string().startsWith('@').optional(),
});

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must use YYYY-MM-DD')
  .refine((value) => {
    const [yearRaw, monthRaw, dayRaw] = value.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
      return false;
    }
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, 'Expiry date must be a valid calendar date');

const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+-rf\s+\//,
  /\bsudo\b/,
  /curl\s.*\|\s*bash/,
  /wget\s.*\|\s*bash/,
];

const validationSetupCommandSchema = z
  .string()
  .refine(
    (command) => !DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command)),
    'validationSetupCommand contains a dangerous command pattern',
  );

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

const codeIntelligenceConfigSchema = z.object({
  serena: z.boolean().optional(),
  roslynCodeLens: z.boolean().optional(),
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
  'agentDonePrompt',
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
  askHumanOnTimeout: z.enum(['continue', 'ask_ai']).default('continue'),
  askAi: z
    .object({
      enabled: z.boolean().default(false),
      model: canonicalModelIdSchema.default(CLAUDE_REVIEWER_MODEL),
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
      'python-node-pg',
      'go124',
      'go124-pw',
      'custom',
    ])
    .nullable()
    .default('node22'),
  buildCommand: z.string().min(1).nullable().default(null),
  startCommand: z.string().min(1).nullable().default(null),
  /** Optional subdirectory under /workspace where build/test/start commands run. */
  buildWorkDir: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9._\-/]+$/, 'buildWorkDir contains invalid characters')
    .nullable()
    .default(null),
  healthPath: z.string().nullable().default('/'),
  healthTimeout: z.number().int().min(10).max(600).nullable().default(120),
  // Nullable on the wire so derived profiles can signal "inherit from parent".
  // The daemon store normalizes null → [] at write time (see profile-store.ts).
  smokePages: z.array(smokePageSchema).nullable().default([]),
  maxValidationAttempts: z.number().int().min(1).max(10).nullable().default(3),
  defaultModel: canonicalModelIdSchema.nullable().default(CLAUDE_DEFAULT_MODEL),
  /** Optional reviewer model for task review. Falls back to defaultModel when null. */
  reviewerModel: canonicalModelIdSchema.nullable().default(null),
  defaultRuntime: z.enum(['claude', 'codex', 'copilot', 'pi']).nullable().default('claude'),
  executionTarget: z.enum(['local', 'sandbox']).nullable().default('local'),
  customInstructions: z.string().max(50_000).nullable().default(null),
  agentDonePrompt: z.string().max(50_000).nullable().default(null),
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
  providerAccountId: providerAccountIdSchema.nullable().default(null),
  providerFailover: providerFailoverPolicySchema.nullable().default(null),
  providerCredentials: providerCredentialsSchema.nullable().default(null),
  testCommand: z.string().nullable().optional().default(null),
  validationSetupCommand: validationSetupCommandSchema.nullable().optional().default(null),
  /**
   * Extra env vars merged into validation phase execs (build/test/lint/sast).
   * Common use: `{ NODE_OPTIONS: "--max-old-space-size=4096" }` to raise V8
   * heap for memory-heavy production bundles. Does not affect agent runtime env.
   */
  buildEnv: z.record(z.string()).nullable().default(null),
  buildTimeout: z.number().int().min(30).max(1800).nullable().default(300),
  testTimeout: z.number().int().min(30).max(3600).nullable().default(600),
  /** Optional lint command run before build. */
  lintCommand: z.string().nullable().optional().default(null),
  lintTimeout: z.number().int().min(10).max(600).nullable().optional().default(120),
  /** Optional SAST command run after lint. */
  sastCommand: z.string().nullable().optional().default(null),
  sastTimeout: z.number().int().min(10).max(1800).nullable().optional().default(300),
  /**
   * How often the merge poller checks the PR for CI / review state changes,
   * in seconds. Null = use the daemon default (60s). Profiles where each fix
   * cycle is fast and trusted can lower this for snappier turnarounds.
   */
  mergePollIntervalSec: z.number().int().min(5).max(3600).nullable().optional().default(null),
  prProvider: z.enum(['github', 'ado']).nullable().default('github'),
  adoPat: z.string().min(1).nullable().default(null),
  adoPatExpiresAt: dateOnlySchema.nullable().default(null),
  githubPat: z.string().min(1).nullable().default(null),
  githubPatExpiresAt: dateOnlySchema.nullable().default(null),
  openrouterApiKey: z.string().min(1).nullable().default(null),
  privateRegistries: z.array(privateRegistrySchema).nullable().default([]),
  registryPat: z.string().min(1).nullable().default(null),
  registryPatExpiresAt: dateOnlySchema.nullable().default(null),
  branchPrefix: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9.\-_/]+$/, 'Branch prefix contains invalid characters')
    .refine((s) => !s.includes('..'), 'Branch prefix cannot contain ".."')
    .nullable()
    .default('autopod/'),
  containerMemoryGb: z.number().min(0.5).max(64).nullable().default(null),
  tokenBudget: z.number().int().min(1000).nullable().default(null),
  tokenBudgetWarnAt: z.number().min(0.1).max(0.99).nullable().default(0.8),
  tokenBudgetPolicy: z.enum(['soft', 'hard']).nullable().default('soft'),
  maxBudgetExtensions: z.number().int().min(0).nullable().default(null),
  // hasWebUi / issueWatcherEnabled: null = inherit from parent (or fall back
  // to the consumer's built-in default — `?? true` for hasWebUi, falsy for
  // issueWatcherEnabled). Do NOT use `.default(...)` here — Zod materializes
  // the default for every PATCH that doesn't include the field, silently
  // re-overriding the column on every save and clobbering inheritance.
  hasWebUi: z.boolean().nullable().optional(),
  issueWatcherEnabled: z.boolean().nullable().optional(),
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
  // trustedSource gates privileged sidecars. Consumers use a strict
  // `!== true` check, so null behaves as "untrusted" — the safe default. Do
  // NOT use `.default(false)` here; it would re-stamp the column on every
  // PATCH and clobber inheritance (see hasWebUi/issueWatcherEnabled above).
  trustedSource: z.boolean().nullable().optional(),
  testPipeline: testPipelineConfigSchema.nullable().default(null),
  securityScan: securityScanPolicySchema.nullable().default(null),
  codeIntelligence: codeIntelligenceConfigSchema.nullable().default(null),
  skipValidationPhases: z
    .array(
      z.enum([
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
      ]),
    )
    .nullable()
    .default(null),
  deployment: z
    .object({
      enabled: z.boolean(),
      env: z.record(z.string()),
      allowedScripts: z.array(z.string().min(1)).optional(),
    })
    .nullable()
    .default(null),
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
    // Repo-less profiles (ephemeral / inheritance anchors) don't need build or start commands.
    // Enforcement of "you need a repo to create PRs" happens at pod-creation time in pod-manager.
    if (data.repoUrl === null) return;
    if (data.buildCommand === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['buildCommand'],
        message: 'buildCommand is required when repoUrl is set',
      });
    }
    if (data.startCommand === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startCommand'],
        message: 'startCommand is required when repoUrl is set',
      });
    }
  });

export const updateProfileSchema = createProfileBaseSchema.partial().omit({ name: true });
