import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
const segment = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (v) =>
      !/[\\/?#%]/.test(v) &&
      [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
      v !== '.' &&
      v !== '..',
  );
export const adoReadOperationSchema = z.enum([
  'code.file',
  'code.search',
  'pr.read',
  'pr.threads',
  'pr.changes',
  'workitem.read',
  'workitem.search',
]);
export const logTableSchema = z.enum([
  'ContainerAppConsoleLogs_CL',
  'ContainerAppSystemLogs_CL',
  'AzureDiagnostics',
  'AppTraces',
  'AppExceptions',
  'AppRequests',
]);
export const serviceAccessRuleSchema = z.discriminatedUnion('service', [
  z
    .object({
      id,
      service: z.literal('ado'),
      organization: segment,
      project: segment,
      repository: segment.optional(),
      operations: z.array(adoReadOperationSchema).min(1).max(7),
    })
    .strict(),
  z
    .object({
      id,
      service: z.literal('azure-logs'),
      workspaceId: z.string().uuid(),
      tables: z.array(logTableSchema).min(1).max(6),
      containerApp: segment.optional(),
    })
    .strict(),
]);
export const serviceAccessSchema = z
  .array(serviceAccessRuleSchema)
  .max(128)
  .superRefine((rules, ctx) => {
    if (new Set(rules.map((r) => r.id)).size !== rules.length)
      ctx.addIssue({ code: 'custom', message: 'Service access rule IDs must be unique' });
    for (const rule of rules) {
      if (
        rule.service === 'ado' &&
        !rule.repository &&
        rule.operations.some((op) => !op.startsWith('workitem.'))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Code and PR access requires an explicit repository',
        });
      if (
        rule.service === 'azure-logs' &&
        rule.containerApp &&
        rule.tables.some((t) => !t.startsWith('ContainerApp'))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Container app scope requires container app log tables',
        });
    }
  });
const limit = z.number().int().min(1).max(100).default(30);
export const serviceReadSchema = z.discriminatedUnion('service', [
  z
    .object({
      service: z.literal('ado'),
      ruleId: id,
      operation: adoReadOperationSchema,
      path: z.string().min(1).max(2048).optional(),
      ref: z.string().min(1).max(256).optional(),
      itemId: z.number().int().positive().optional(),
      query: z.string().min(1).max(1000).optional(),
      limit,
    })
    .strict(),
  z
    .object({
      service: z.literal('azure-logs'),
      ruleId: id,
      table: logTableSchema,
      contains: z.string().max(1000).optional(),
      timespan: z.enum(['PT15M', 'PT1H', 'PT6H', 'P1D', 'P7D']).default('PT1H'),
      limit,
    })
    .strict(),
]);
export type ServiceAccessRule = z.infer<typeof serviceAccessRuleSchema>;
export type ServiceReadRequest = z.infer<typeof serviceReadSchema>;
