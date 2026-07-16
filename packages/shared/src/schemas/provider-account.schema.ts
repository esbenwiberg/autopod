import { z } from 'zod';

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

export const providerAccountProviderSchema = z.enum([
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

const providerAccountCredentialsSchema = z.union([
  anthropicCredentialsSchema,
  openAiCredentialsSchema,
  maxRefreshCredentialsSchema,
  maxSetupTokenCredentialsSchema,
  foundryCredentialsSchema,
  copilotCredentialsSchema,
  openRouterCredentialsSchema,
  piOAuthCredentialsSchema,
]);

export const createProviderAccountSchema = z
  .object({
    id: providerAccountIdSchema.optional(),
    name: providerAccountNameSchema,
    provider: providerAccountProviderSchema,
    credentials: providerAccountCredentialsSchema.nullable().optional().default(null),
  })
  .superRefine((data, ctx) => {
    if (data.credentials && data.credentials.provider !== data.provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['credentials'],
        message: 'Provider account credentials must match the account provider',
      });
    }
  });

export const updateProviderAccountSchema = z
  .object({
    name: providerAccountNameSchema.optional(),
    credentials: providerAccountCredentialsSchema.nullable().optional(),
  })
  .strict();

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
