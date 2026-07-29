import { z } from 'zod';
import { PODSITTER_ACTIONS } from '../types/podsitter.js';
import { providerAccountIdSchema } from './provider-account.schema.js';

const isoTimestampSchema = z.string().datetime({ offset: true });
const boundedTextSchema = z.string().max(4_000);
const boundedIdentifierSchema = z.string().trim().min(1).max(256);
const emptyArgumentsSchema = z.object({}).strict();
const forceArgumentsSchema = z
  .object({
    failedPhases: z.array(boundedIdentifierSchema).min(1).max(50),
    manualEvidenceRefs: z.array(boundedIdentifierSchema).min(1).max(100),
  })
  .strict();

export const podsitterActionArgumentsSchemas = {
  no_action: emptyArgumentsSchema,
  report: z.object({ message: boundedTextSchema.min(1) }).strict(),
  approve: emptyArgumentsSchema,
  reject: z.object({ message: boundedTextSchema.min(1) }).strict(),
  tell: z.object({ message: boundedTextSchema.min(1) }).strict(),
  nudge: z.object({ message: boundedTextSchema.min(1) }).strict(),
  dismiss_validation_finding: z
    .object({
      findingId: boundedIdentifierSchema,
      reason: boundedTextSchema.min(1),
    })
    .strict(),
  guide_validation_fix: z
    .object({
      findingId: boundedIdentifierSchema,
      guidance: boundedTextSchema.min(1),
    })
    .strict(),
  extend_budget: emptyArgumentsSchema,
  kick: emptyArgumentsSchema,
  interrupt_validation: emptyArgumentsSchema,
  revalidate: emptyArgumentsSchema,
  extend_validation_attempts: emptyArgumentsSchema,
  approve_fact_waiver: z
    .object({
      factId: boundedIdentifierSchema,
      justification: boundedTextSchema.min(1),
    })
    .strict(),
  extend_pr_attempts: emptyArgumentsSchema,
  spawn_fix: emptyArgumentsSchema,
  retry_pr: emptyArgumentsSchema,
  update_from_base: emptyArgumentsSchema,
  inject_credential: z.object({ credentialId: boundedIdentifierSchema }).strict(),
  install_tool: z.object({ toolName: boundedIdentifierSchema }).strict(),
  recover_worktree: emptyArgumentsSchema,
  force_approve: forceArgumentsSchema,
  skip_validation: forceArgumentsSchema,
  force_complete: forceArgumentsSchema,
  fix_manually: z.object({ instructions: boundedTextSchema.min(1) }).strict(),
} satisfies Record<(typeof PODSITTER_ACTIONS)[number], z.ZodType>;

export const operatorActorSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('human'),
      userId: z.string().min(1).max(256),
      displayName: z.string().trim().min(1).max(256).optional(),
    })
    .strict(),
  z.object({ type: z.literal('automation'), id: z.string().min(1).max(256) }).strict(),
  z
    .object({
      type: z.literal('podsitter'),
      decisionId: z.string().min(1).max(128),
      providerAccountId: providerAccountIdSchema,
      model: z.string().trim().min(1).max(256),
    })
    .strict(),
]);

export const podsitterDecisionTargetSchema = z
  .object({
    providerAccountId: providerAccountIdSchema,
    runtime: z.enum(['claude', 'codex', 'copilot', 'pi']),
    model: z.string().trim().min(1).max(256),
    reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

export const podsitterActivationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('always') }).strict(),
  z
    .object({
      mode: z.literal('recurring'),
      cronExpression: z.string().trim().min(1).max(256),
      durationMinutes: z
        .number()
        .int()
        .positive()
        .max(7 * 24 * 60),
      timeZone: z.string().trim().min(1).max(128),
    })
    .strict(),
]);

export const podsitterBudgetsSchema = z
  .object({
    maxDecisionsPerWindow: z.number().int().positive().max(10_000),
    maxActionsPerWindow: z.number().int().positive().max(10_000),
  })
  .strict();

export const podsitterConfigurationInputSchema = z
  .object({
    enabled: z.boolean(),
    activation: podsitterActivationSchema,
    authorizedUntil: isoTimestampSchema.nullable(),
    profileScope: z.array(z.string().trim().min(1).max(128)).max(1_000).nullable(),
    decisionTarget: podsitterDecisionTargetSchema.nullable(),
    budgets: podsitterBudgetsSchema,
    updatedBy: operatorActorSchema,
  })
  .strict();

export const podsitterDecisionSchema = z
  .object({
    contractVersion: z.literal(1),
    attentionSignature: z.string().min(1).max(256),
    action: z.enum(PODSITTER_ACTIONS),
    arguments: z.record(z.unknown()),
    reason: boundedTextSchema.min(1),
    evidenceRefs: z.array(z.string().min(1).max(256)).max(100),
    confidence: z.enum(['low', 'medium', 'high']),
    remainingRisk: boundedTextSchema,
    stopCondition: boundedTextSchema.min(1),
  })
  .strict()
  .superRefine((decision, context) => {
    const result = podsitterActionArgumentsSchemas[decision.action].safeParse(decision.arguments);
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({
          ...issue,
          path: ['arguments', ...issue.path],
        });
      }
    }
  });
