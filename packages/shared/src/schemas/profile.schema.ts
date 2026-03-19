import { z } from 'zod';
import { injectedMcpServerSchema, injectedClaudeMdSectionSchema } from './injection.schema.js';

const pageAssertionSchema = z.object({
  selector: z.string().min(1),
  type: z.enum(['exists', 'text_contains', 'visible', 'count']),
  value: z.string().optional(),
});

const validationPageSchema = z.object({
  path: z.string().min(1).startsWith('/'),
  assertions: z.array(pageAssertionSchema).optional(),
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
  template: z.enum(['node22', 'node22-pw', 'dotnet9', 'python312', 'custom']).default('node22'),
  buildCommand: z.string().min(1),
  startCommand: z.string().min(1),
  healthPath: z.string().default('/'),
  healthTimeout: z.number().int().min(10).max(600).default(120),
  validationPages: z.array(validationPageSchema).default([]),
  maxValidationAttempts: z.number().int().min(1).max(10).default(3),
  defaultModel: z.string().default('opus'),
  defaultRuntime: z.enum(['claude', 'codex']).default('claude'),
  executionTarget: z.enum(['local', 'aci']).default('local'),
  customInstructions: z.string().max(50_000).nullable().default(null),
  escalation: escalationConfigSchema.default({}),
  extends: z.string().nullable().default(null),
  mcpServers: z.array(injectedMcpServerSchema).default([]),
  claudeMdSections: z.array(injectedClaudeMdSectionSchema).default([]),
});

export const updateProfileSchema = createProfileSchema.partial().omit({ name: true });
