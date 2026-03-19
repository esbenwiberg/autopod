import { z } from 'zod';

export const createSessionRequestSchema = z.object({
  profileName: z.string().min(1).max(64),
  task: z.string().min(1).max(10_000),
  model: z.string().min(1).max(32).optional(),
  runtime: z.enum(['claude', 'codex']).optional(),
  executionTarget: z.enum(['local', 'aci']).optional(),
  branch: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9\-_/]+$/, 'Branch name contains invalid characters')
    .optional(),
  skipValidation: z.boolean().optional(),
});

export const sessionStatusSchema = z.enum([
  'queued',
  'provisioning',
  'running',
  'awaiting_input',
  'validating',
  'validated',
  'failed',
  'approved',
  'merging',
  'complete',
  'killing',
  'killed',
]);

export const sendMessageSchema = z.object({
  message: z.string().min(1).max(50_000),
});
