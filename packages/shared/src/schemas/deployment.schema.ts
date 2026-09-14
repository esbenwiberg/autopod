import { z } from 'zod';

export const deploymentRequestSchema = z
  .object({
    operationKey: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
    scriptPath: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
      .refine((v) => v.split('/').every((p) => p !== '.' && p !== '..')),
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine((v) => !v.includes('\0')),
      )
      .max(64)
      .default([]),
  })
  .strict();
export type DeploymentRequest = z.infer<typeof deploymentRequestSchema>;
