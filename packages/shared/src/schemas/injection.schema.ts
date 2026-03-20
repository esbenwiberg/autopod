import { z } from 'zod';

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
