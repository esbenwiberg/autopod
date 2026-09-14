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
    accountByProfile: z.record(configurationIdSchema).optional(),
    accountFailover: z.record(providerFailoverPolicySchema.nullable()).optional(),
    registryCredentialByProfile: z.record(configurationIdSchema).optional(),
    secretReferencesByProfile: z.record(z.record(configurationIdSchema)).optional(),
    githubAccessByProfile: z.record(githubAccessPresetSchema).optional(),
    remoteByProfile: z.record(configurationUrlSchema).optional(),
    serviceAccessByProfile: z.record(serviceAccessSchema).optional(),
    deploymentByProfile: z
      .record(
        z
          .object({
            source: z.literal('published-default'),
            targetId: configurationIdSchema,
            allowedScripts: z.array(deploymentRequestSchema.shape.scriptPath).min(1),
          })
          .strict(),
      )
      .optional(),
    profileReplacementByProfile: z.record(z.string().min(1)).optional(),
    resolvedToolPackByProfile: z.record(toolPackSchema).optional(),
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
    pimByProfile: z.record(z.array(pimSelectionSchema)).optional(),
    usualProfileByRemote: z.record(z.string().min(1)).optional(),
    trustedByProfile: z.record(z.boolean()).optional(),
    watcherEnabledByProfile: z.record(z.boolean()).optional(),
  })
  .strict() satisfies z.ZodType<LegacyMigrationBindings, z.ZodTypeDef, unknown>;
