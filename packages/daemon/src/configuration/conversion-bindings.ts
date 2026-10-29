import {
  configurationIdSchema,
  configurationUrlSchema,
  deploymentRequestSchema,
  githubAccessPresetSchema,
  pimSelectionSchema,
  providerFailoverPolicySchema,
  serviceAccessSchema,
  toolPackSchema,
} from '@autopod/shared';
import { z } from 'zod';
import type { LegacyMigrationBindings } from './legacy-profile-migration.js';

/** Mapping files contain references and policy choices, never credential values. */
export const conversionBindingsSchema = z
  .object({
    accountByProfile: z.record(z.string(), configurationIdSchema).optional(),
    accountFailover: z.record(z.string(), providerFailoverPolicySchema.nullable()).optional(),
    registryCredentialByProfile: z.record(z.string(), configurationIdSchema).optional(),
    secretReferencesByProfile: z
      .record(z.string(), z.record(z.string(), configurationIdSchema))
      .optional(),
    githubAccessByProfile: z.record(z.string(), githubAccessPresetSchema).optional(),
    remoteByProfile: z.record(z.string(), configurationUrlSchema).optional(),
    serviceAccessByProfile: z.record(z.string(), serviceAccessSchema).optional(),
    deploymentByProfile: z
      .record(
        z.string(),
        z
          .object({
            source: z.literal('published-default'),
            targetId: configurationIdSchema,
            allowedScripts: z.array(deploymentRequestSchema.shape.scriptPath).min(1),
          })
          .strict(),
      )
      .optional(),
    profileReplacementByProfile: z.record(z.string(), z.string().min(1)).optional(),
    resolvedToolPackByProfile: z.record(z.string(), toolPackSchema).optional(),
    codeIntelligenceVersions: z
      .object({
        serena: z
          .string()
          .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
          .optional(),
        roslynCodeLens: z
          .string()
          .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
          .optional(),
      })
      .strict()
      .optional(),
    pimByProfile: z.record(z.string(), z.array(pimSelectionSchema)).optional(),
    usualProfileByRemote: z.record(z.string(), z.string().min(1)).optional(),
    trustedByProfile: z.record(z.string(), z.boolean()).optional(),
    watcherEnabledByProfile: z.record(z.string(), z.boolean()).optional(),
  })
  .strict() satisfies z.ZodType<LegacyMigrationBindings, unknown>;
