import { z } from 'zod';
import { MAX_PROVIDER_FAILOVER_TARGETS } from '../constants.js';
import { PROVIDER_CATALOG } from '../provider-catalog/compiled-manifest.js';
import type { PublicProviderCatalog } from '../types/provider-catalog.js';

export const providerAccountIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'providerAccountId must be a stable lowercase id');

export const providerAccountNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 ._-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/,
    'Provider account name must be human-readable and cannot start or end with punctuation',
  );

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
  scopes: z.array(z.string()).optional(),
  subscriptionType: z.string().optional(),
  rateLimitTier: z.string().optional(),
});

const maxSetupTokenCredentialsSchema = z.object({
  provider: z.literal('max'),
  authMode: z.literal('setup-token').optional(),
  oauthToken: z.string().min(1),
});

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

export const providerFailoverTargetSchema = z
  .object({
    providerAccountId: providerAccountIdSchema,
    runtime: z.enum(['claude', 'codex', 'copilot', 'pi']),
    model: z.string().trim().min(1).max(256),
  })
  .strict();

export const providerFailoverPolicySchema = z
  .object({
    targets: z.array(providerFailoverTargetSchema).max(MAX_PROVIDER_FAILOVER_TARGETS),
    maxHops: z.number().int().min(1).max(MAX_PROVIDER_FAILOVER_TARGETS).optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    for (const [index, target] of policy.targets.entries()) {
      if (seen.has(target.providerAccountId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targets', index],
          message: 'Failover targets must not contain duplicate provider accounts',
        });
      }
      seen.add(target.providerAccountId);
    }
    if (policy.maxHops !== undefined && policy.maxHops > policy.targets.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxHops'],
        message: 'maxHops cannot exceed the number of failover targets',
      });
    }
  });

export function createProviderAccountSchemas(catalog: PublicProviderCatalog = PROVIDER_CATALOG) {
  const catalogProviderIds = new Set(catalog.providers.map((provider) => provider.id));
  const providerSchema = providerAccountIdSchema.refine(
    (providerId) => catalogProviderIds.has(providerId),
    'Provider account provider must exist in the compiled provider catalog',
  );
  const apiKeyCredentialsSchema = z
    .object({
      provider: z.literal('api-key'),
      providerId: providerAccountIdSchema,
      apiKey: z.string().min(1),
    })
    .superRefine((credentials, ctx) => {
      const provider = catalog.providers.find(
        (candidate) => candidate.id === credentials.providerId,
      );
      if (provider?.implementation.kind !== 'generic-pi-api') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['providerId'],
          message: 'Generic API-key credentials require a generic Pi provider from the catalog',
        });
      } else if (
        provider.policy.authorization !== 'supported' ||
        provider.policy.runnable !== true
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['providerId'],
          message: 'Generic API-key credentials require a supported, runnable provider',
        });
      } else if (!provider.credentialOptions.some((option) => option.kind === 'api-key')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['providerId'],
          message:
            'Generic API-key credentials require a provider that supports API-key authentication',
        });
      }
    });
  const credentialsSchema = z.union([
    anthropicCredentialsSchema,
    openAiCredentialsSchema,
    maxRefreshCredentialsSchema,
    maxSetupTokenCredentialsSchema,
    foundryCredentialsSchema,
    copilotCredentialsSchema,
    openRouterCredentialsSchema,
    piOAuthCredentialsSchema,
    apiKeyCredentialsSchema,
  ]);
  const createSchema = z
    .object({
      id: providerAccountIdSchema.optional(),
      name: providerAccountNameSchema,
      provider: providerSchema,
      credentials: credentialsSchema.nullable().optional().default(null),
      failoverPolicy: providerFailoverPolicySchema.nullable().optional().default(null),
    })
    .superRefine((data, ctx) => {
      const credentialProviderId =
        data.credentials?.provider === 'api-key'
          ? data.credentials.providerId
          : data.credentials?.provider;
      if (credentialProviderId && credentialProviderId !== data.provider) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['credentials'],
          message: 'Provider account credentials must match the account provider',
        });
      }
      if (data.failoverPolicy && data.failoverPolicy.targets.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['failoverPolicy', 'targets'],
          message: 'Provider account failover policies must contain at least one target',
        });
      }
    });
  const updateSchema = z
    .object({
      name: providerAccountNameSchema.optional(),
      credentials: credentialsSchema.nullable().optional(),
      failoverPolicy: providerFailoverPolicySchema.nullable().optional(),
    })
    .strict()
    .superRefine((data, ctx) => {
      if (data.failoverPolicy && data.failoverPolicy.targets.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['failoverPolicy', 'targets'],
          message: 'Provider account failover policies must contain at least one target',
        });
      }
    });

  return {
    providerAccountProviderSchema: providerSchema,
    genericApiKeyCredentialsSchema: apiKeyCredentialsSchema,
    createProviderAccountSchema: createSchema,
    updateProviderAccountSchema: updateSchema,
  };
}

export const {
  providerAccountProviderSchema,
  genericApiKeyCredentialsSchema,
  createProviderAccountSchema,
  updateProviderAccountSchema,
} = createProviderAccountSchemas();

export const linkProviderAccountSchema = z.object({
  profileName: z.string().min(1),
  // Default to clearing: once a profile resolves through the account, its inline
  // providerCredentials are dead weight and a stale copy is a latent auth footgun.
  clearLegacyCredentials: z.boolean().optional().default(true),
});

export const importProviderAccountFromProfileSchema = z.object({
  profileName: z.string().min(1),
  accountId: providerAccountIdSchema.optional(),
  accountName: providerAccountNameSchema.optional(),
  linkProfileNames: z.array(z.string().min(1)).optional().default([]),
  // Import centralizes creds onto the account — clear the profile copy by default.
  clearLegacyCredentials: z.boolean().optional().default(true),
});
