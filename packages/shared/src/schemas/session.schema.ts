import { z } from 'zod';

export const createSessionRequestSchema = z
  .object({
    profileName: z.string().min(1).max(64),
    task: z.string().max(10_000),
    model: z.string().min(1).max(32).optional(),
    runtime: z.enum(['claude', 'codex']).optional(),
    executionTarget: z.enum(['local', 'aci']).optional(),
    branch: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9\-_/]+$/, 'Branch name contains invalid characters')
      .optional(),
    branchPrefix: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9\-_/]+$/, 'Branch prefix contains invalid characters')
      .optional(),
    skipValidation: z.boolean().optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(2_000)).optional(),
    outputMode: z.enum(['pr', 'artifact', 'workspace']).optional(),
    baseBranch: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9\-_/]+$/, 'Branch name contains invalid characters')
      .optional(),
    acFrom: z
      .string()
      .min(1)
      .max(500)
      .refine((p) => !p.startsWith('/') && !p.includes('..'), {
        message: 'acFrom must be a relative path without ".." segments',
      })
      .optional(),
    linkedSessionId: z.string().min(1).max(16).optional(),
    pimGroups: z
      .array(
        z.object({
          groupId: z.string().uuid(),
          displayName: z.string().min(1).max(128).optional(),
          duration: z.string().min(1).max(32).optional(),
          justification: z.string().min(1).max(500).optional(),
        }),
      )
      .optional(),
  })
  .refine((data) => data.outputMode === 'workspace' || data.task.length > 0, {
    message: 'task: String must contain at least 1 character(s)',
    path: ['task'],
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
  'paused',
  'killing',
  'killed',
]);

export const sendMessageSchema = z.object({
  message: z.string().min(1).max(50_000),
});
