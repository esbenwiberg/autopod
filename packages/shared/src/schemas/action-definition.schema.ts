import { z } from 'zod';

// ─── Auth Config ────────────────────────────────────────────────
const bearerAuthSchema = z.object({
  type: z.literal('bearer'),
  secret: z.string().min(1),
});

const basicAuthSchema = z.object({
  type: z.literal('basic'),
  username: z.string().min(1),
  password: z.string().min(1),
});

const customHeaderAuthSchema = z.object({
  type: z.literal('custom-header'),
  name: z.string().min(1),
  value: z.string().min(1),
});

const noAuthSchema = z.object({
  type: z.literal('none'),
});

export const authConfigSchema = z.discriminatedUnion('type', [
  bearerAuthSchema,
  basicAuthSchema,
  customHeaderAuthSchema,
  noAuthSchema,
]);

// ─── Parameter Definition ───────────────────────────────────────
export const paramDefSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean(),
  description: z.string().min(1).max(500),
  default: z.unknown().optional(),
  enum: z.array(z.string()).optional(),
});

// ─── Action Group / Handler ─────────────────────────────────────
export const actionGroupSchema = z.enum([
  'github-issues',
  'github-prs',
  'github-code',
  'ado-workitems',
  'ado-prs',
  'ado-code',
  'azure-logs',
  'azure-pim',
  'custom',
]);

export const actionHandlerSchema = z.enum(['github', 'ado', 'azure-logs', 'azure-pim', 'http']);

// ─── Endpoint (HTTP handler) ────────────────────────────────────
const endpointSchema = z.object({
  url: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT']),
  auth: authConfigSchema.optional(),
  timeout: z.number().int().min(1000).max(60_000).optional(),
});

const requestMappingSchema = z.object({
  bodyMapping: z.record(z.string()).optional(),
  queryMapping: z.record(z.string()).optional(),
  pathMapping: z.record(z.string()).optional(),
});

// ─── Response ───────────────────────────────────────────────────
const responseSchema = z.object({
  resultPath: z.string().optional(),
  fields: z.array(z.string().min(1)).min(1),
  redactFields: z.array(z.string()).optional(),
});

// ─── Action Definition ──────────────────────────────────────────
export const actionDefinitionSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/, 'Action name must be lowercase alphanumeric with underscores'),
    description: z.string().min(1).max(1000),
    group: actionGroupSchema,
    handler: actionHandlerSchema,
    params: z.record(paramDefSchema),
    endpoint: endpointSchema.optional(),
    request: requestMappingSchema.optional(),
    response: responseSchema,
  })
  .refine(
    (data) => {
      // HTTP handler requires endpoint
      if (data.handler === 'http' && !data.endpoint) {
        return false;
      }
      return true;
    },
    { message: 'HTTP handler requires an endpoint configuration' },
  )
  .refine(
    (data) => {
      // Non-HTTP handlers should not have endpoint
      if (data.handler !== 'http' && data.endpoint) {
        return false;
      }
      return true;
    },
    { message: 'Endpoint configuration is only valid for HTTP handler' },
  );

// ─── Action Override ────────────────────────────────────────────
export const actionOverrideSchema = z.object({
  action: z.string().min(1).max(64),
  allowedResources: z.array(z.string()).optional(),
  requiresApproval: z.boolean().optional(),
  disabled: z.boolean().optional(),
});

// ─── Sanitization / Quarantine ──────────────────────────────────
export const sanitizationPresetSchema = z.enum(['strict', 'standard', 'relaxed']);

export const dataSanitizationConfigSchema = z.object({
  preset: sanitizationPresetSchema.default('standard'),
  allowedDomains: z.array(z.string()).optional(),
});

export const quarantineConfigSchema = z.object({
  enabled: z.boolean(),
  threshold: z.number().min(0).max(1).default(0.5),
  blockThreshold: z.number().min(0).max(1).default(0.8),
  onBlock: z.enum(['skip', 'ask_human']).default('skip'),
});

// ─── Action Policy ──────────────────────────────────────────────
export const actionPolicySchema = z
  .object({
    enabledGroups: z.array(actionGroupSchema).default([]),
    enabledActions: z.array(z.string().min(1).max(64)).default([]).optional(),
    actionOverrides: z.array(actionOverrideSchema).optional(),
    customActions: z.array(actionDefinitionSchema).max(50).optional(),
    sanitization: dataSanitizationConfigSchema.default({}),
    quarantine: quarantineConfigSchema.optional(),
  })
  .refine((d) => d.enabledGroups.length > 0 || (d.enabledActions?.length ?? 0) > 0, {
    message: 'At least one action group or individual action must be enabled',
  });

// ─── Output Mode ────────────────────────────────────────────────
export const outputModeSchema = z.enum(['pr', 'artifact', 'workspace']);
