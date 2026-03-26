import { z } from 'zod';

const localSkillSourceSchema = z.object({
  type: z.literal('local'),
  path: z.string().min(1),
});

const githubSkillSourceSchema = z.object({
  type: z.literal('github'),
  repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in owner/repo format'),
  path: z.string().optional(),
  ref: z.string().max(256).optional(),
  token: z.string().optional(),
});

export const injectedSkillSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/, 'Skill names must be lowercase alphanumeric, hyphens, or underscores'),
  source: z.discriminatedUnion('type', [localSkillSourceSchema, githubSkillSourceSchema]),
  description: z.string().max(500).optional(),
});

export const injectedMcpServerSchema = z.object({
  name: z.string().min(1).max(64),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  description: z.string().max(500).optional(),
  toolHints: z.array(z.string().max(200)).max(20).optional(),
});

export const injectedClaudeMdSectionSchema = z.object({
  heading: z.string().min(1).max(100),
  priority: z.number().int().min(0).max(100).default(50),
  content: z.string().max(50_000).optional(),
  fetch: z
    .object({
      url: z.string().url(),
      authorization: z.string().optional(),
      body: z.record(z.unknown()).optional(),
      timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
    })
    .optional(),
  maxTokens: z.number().int().min(100).max(32_000).default(4000),
});
