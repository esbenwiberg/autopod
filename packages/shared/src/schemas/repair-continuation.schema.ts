import { z } from 'zod';

/** This protocol authorizes one conditional coding segment, never delivery or a retry grant. */
export const REPAIR_CONTINUATION_VERSION = 1 as const;
export const ENVIRONMENT_QUALIFICATION_TTL_MS = 5 * 60 * 1000;
export const REPAIR_REPORT_LIMIT = 100;
export const REPAIR_REPORT_BYTES_LIMIT = 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const text = z.string().trim().min(1).max(1024);
const timestamp = z.string().datetime();
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const launcher = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/);

/** Absent historical bindings MUST remain checks-only; do not change legacy request meaning. */
export const repairContinuationExecutionModeSchema = z
  .enum(['checks_only', 'qualify_then_code_once'])
  .default('checks_only');

/** Lookup-only dependencies, not operation, credential, builder or native-check claims. */
export const prerequisiteBlockerV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.literal('missing-execution-prerequisites'),
    requirementsHash: hash,
    launchers: z
      .array(launcher)
      .min(1)
      .max(64)
      .refine((values) => new Set(values).size === values.length, 'Duplicate launchers'),
  })
  .strict();

export const repairContinuationRefusalCodeSchema = z.enum([
  'unavailable',
  'unsupported_task',
  'unsupported_needs',
  'incomplete_reports',
  'stale_selection',
  'conflict',
  'custody_held',
  'execution_unsettled',
  'pending_decision',
  'uncollected_guidance',
  'source_unavailable',
  'configuration_changed',
  'retry_blocked',
  'budget_blocked',
  'qualification_failed',
  'qualification_unknown',
  'qualification_expired',
  'source_seal_failed',
  'checks_failed',
  'internal_error',
]);
export const repairContinuationRefusalSchema = z
  .object({
    code: repairContinuationRefusalCodeSchema,
    message: text,
  })
  .strict();
const refusals = z.array(repairContinuationRefusalSchema).max(32);

/** POST /pods/:podId/repair-continuation-v1. No proof, actor, epochs, commands or grants accepted. */
export const repairContinuationRequestV1Schema = z
  .object({
    version: z.literal(1),
    intent: z.literal('qualify_then_code_once'),
    id,
    expectedGeneration: generation,
    expectedResultHash: hash,
    expectedReportSetHash: hash,
    sourceHead: gitSha,
    executionProfileId: id,
    expectedExecutionDigest: hash,
    expectedBindingDigest: hash,
    reason: z.string().trim().min(10).max(4000),
  })
  .strict();

/** GET .../preview?sourceHead=...&executionProfileId=...; configuration only, no effects. */
export const repairContinuationPreviewQueryV1Schema = z
  .object({
    sourceHead: gitSha,
    executionProfileId: id,
  })
  .strict();
export const repairContinuationSelectionV1Schema = z
  .object({
    expectedGeneration: generation,
    expectedResultHash: hash,
    expectedReportSetHash: hash,
    sourceHead: gitSha,
    executionProfileId: id,
    expectedExecutionDigest: hash,
    expectedBindingDigest: hash,
    requirementsHash: hash,
    target: z.literal('local'),
  })
  .strict();
/** Bounded software/resource display only. Authority outside these fields remains frozen. */
export const repairExecutionDisplayV1Schema = z
  .object({
    target: z.enum(['local', 'sandbox']),
    template: z.string().min(1).max(128),
    imageKey: hash,
    platform: z.enum(['linux/amd64', 'linux/arm64', 'darwin/amd64', 'darwin/arm64']),
    memoryGb: z.number().positive().max(1024),
    cpus: z.number().positive().max(1024).nullable(),
  })
  .strict();
export const repairConfigurationDiffV1Schema = z
  .object({
    before: repairExecutionDisplayV1Schema,
    after: repairExecutionDisplayV1Schema,
  })
  .strict();

/** Read-only display composition; failures stay visibly unknown, never implicit eligibility. */
export function repairContinuationContextPaths(podId: string) {
  const base = `/pods/${encodeURIComponent(podId)}`;
  return {
    sourceAndReports: `${base}/checkpoint-recovery`,
    cumulativeBudget: `${base}/task-execution`,
    workerRetries: `${base}/retry-state?stage=worker`,
    startupRetries: `${base}/retry-state?stage=sandbox_startup`,
    validationRetries: `${base}/retry-state?stage=validation`,
  };
}

export const repairContinuationPreviewV1Schema = z
  .object({
    version: z.literal(1),
    intent: z.literal('qualify_then_code_once'),
    podId: id,
    configurationOnly: z.literal(true),
    actualQualification: z.literal('not_run'),
    conditionalAttemptEligible: z.boolean(),
    selection: repairContinuationSelectionV1Schema.nullable(),
    configurationDiff: repairConfigurationDiffV1Schema.nullable(),
    refusals,
  })
  .strict()
  .refine(
    (v) =>
      !v.conditionalAttemptEligible ||
      (v.selection !== null && v.configurationDiff !== null && v.refusals.length === 0),
    'Conditional eligibility requires a complete static selection without refusals',
  );

export const repairContinuationStateV1Schema = z.enum([
  'claimed',
  'preparing',
  'provisioning',
  'qualifying',
  'qualified',
  'coding',
  'sealing',
  'checking',
  'validated',
  'failed',
  'unknown',
]);
export const repairSourceIdentityV1Schema = z
  .object({
    repository: z.string().min(1).max(2048),
    head: gitSha,
    tree: gitSha,
    baseCommitSha: gitSha,
  })
  .strict();
export const repairImageIdentityV1Schema = z
  .object({
    kind: z.literal('docker-image-id'),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

/** Daemon-only immutable binding, never supplied by the human request or MCP worker. */
export const environmentQualificationBindingV1Schema = z
  .object({
    version: z.literal(1),
    operationId: id,
    requestHash: hash,
    podId: id,
    taskId: id,
    executionId: id,
    custodyId: id,
    originalGeneration: generation,
    candidateGeneration: generation,
    originalResultHash: hash,
    reportSetHash: hash,
    requirementsHash: hash,
    originalLaunchDigest: hash,
    replacementLaunchDigest: hash,
    configurationHash: hash,
    sourceEpoch: hash,
    credentialEpoch: hash,
    resourceEpoch: hash,
    source: repairSourceIdentityV1Schema,
    target: z.literal('local'),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    resourceKey: z.string().min(1).max(2048),
    expectedImage: repairImageIdentityV1Schema,
    platform: z.enum(['linux/amd64', 'linux/arm64']),
    executionContextHash: hash,
    recoveryFork: z
      .object({ parentPodId: id, contextHash: hash, packetHash: hash, filesHash: hash })
      .strict()
      .optional(),
  })
  .strict();
export const environmentQualificationOutcomeSchema = z.enum([
  'qualified',
  'failed',
  'unknown',
  'unsupported',
]);
export const environmentQualificationObservationV1Schema = z
  .object({
    prerequisite: z.enum([
      'resource_identity',
      'image',
      'platform',
      'source',
      'memory',
      'cpu',
      'streaming',
      'agent_cli',
      'launcher',
      'preparation',
    ]),
    launcher: launcher.optional(),
    outcome: environmentQualificationOutcomeSchema,
    code: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Z][A-Z0-9_]*$/),
    detail: text,
  })
  .strict();
/** Evidence, NOT permission to run. Durable backend adds receipt ID and atomic one-use consumption. */
export const environmentQualificationEvidenceV1Schema = z
  .object({
    version: z.literal(1),
    binding: environmentQualificationBindingV1Schema,
    bindingDigest: hash,
    probeVersion: z.literal(1),
    daemonCommit: z.string().max(128).nullable(),
    implementationHash: hash.nullable(),
    startedAt: timestamp,
    finishedAt: timestamp,
    expiresAt: timestamp,
    outcome: environmentQualificationOutcomeSchema,
    observations: z.array(environmentQualificationObservationV1Schema).min(1).max(96),
    provenanceId: id.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const start = Date.parse(value.startedAt);
    const end = Date.parse(value.finishedAt);
    const expiry = Date.parse(value.expiresAt);
    if (end < start || expiry < end || expiry - end > ENVIRONMENT_QUALIFICATION_TTL_MS)
      ctx.addIssue({ code: 'custom', message: 'Invalid qualification lifetime' });
    if (value.outcome === 'qualified' && value.observations.some((v) => v.outcome !== 'qualified'))
      ctx.addIssue({ code: 'custom', message: 'Qualification requires all positive observations' });
  });

/** Separate immutable fact: never rewrites selected/prepared source or qualification input. */
export const repairCodingFinalSourceV1Schema = z
  .object({
    version: z.literal(1),
    operationId: id,
    generation,
    taskRunId: id,
    selectedHead: gitSha,
    source: repairSourceIdentityV1Schema,
    clean: z.literal(true),
    descendant: z.literal(true),
    workerSettled: z.literal(true),
    sealedAt: timestamp,
    reportsHash: hash,
  })
  .strict();
export const repairContinuationOperationV1Schema = z
  .object({
    /** Opaque retained operation/custody ID; request.id remains the external replay key. */
    operationId: id,
    version: z.literal(1),
    intent: z.literal('qualify_then_code_once'),
    podId: id,
    request: repairContinuationRequestV1Schema,
    state: repairContinuationStateV1Schema,
    createdAt: timestamp,
    updatedAt: timestamp,
    originalGeneration: generation,
    candidateGeneration: generation.nullable(),
    qualification: environmentQualificationEvidenceV1Schema.nullable(),
    codingFinalSource: repairCodingFinalSourceV1Schema.nullable(),
    codingAdmission: z.enum(['not_admitted', 'consumed', 'unknown']),
    checks: z.enum(['not_started', 'running', 'passed', 'failed', 'unknown']),
    refusals,
    originalResourcesRetained: z.literal(true),
    requiresHumanApproval: z.literal(true),
    publicationAuthorized: z.literal(false),
  })
  .strict();
/** GET base endpoint; null hashes mean unavailable, not an empty report set or implicit grant. */
export const repairContinuationInspectionV1Schema = z
  .object({
    version: z.literal(1),
    intent: z.literal('qualify_then_code_once'),
    podId: id,
    generation,
    available: z.boolean(),
    expectedResultHash: hash.nullable(),
    expectedReportSetHash: hash.nullable(),
    sourceHead: gitSha.nullable(),
    requirementsHash: hash.nullable(),
    operation: repairContinuationOperationV1Schema.nullable(),
    refusals,
  })
  .strict();

export type RepairExecutionDisplayV1 = z.infer<typeof repairExecutionDisplayV1Schema>;
export type RepairConfigurationDiffV1 = z.infer<typeof repairConfigurationDiffV1Schema>;
export type PrerequisiteBlockerV1 = z.infer<typeof prerequisiteBlockerV1Schema>;
export type RepairContinuationExecutionMode = z.infer<typeof repairContinuationExecutionModeSchema>;
export type RepairContinuationRefusalCode = z.infer<typeof repairContinuationRefusalCodeSchema>;
export type RepairContinuationRefusal = z.infer<typeof repairContinuationRefusalSchema>;
export type RepairContinuationRequestV1 = z.infer<typeof repairContinuationRequestV1Schema>;
export type RepairContinuationPreviewQueryV1 = z.infer<
  typeof repairContinuationPreviewQueryV1Schema
>;
export type RepairContinuationSelectionV1 = z.infer<typeof repairContinuationSelectionV1Schema>;
export type RepairContinuationPreviewV1 = z.infer<typeof repairContinuationPreviewV1Schema>;
export type RepairContinuationInspectionV1 = z.infer<typeof repairContinuationInspectionV1Schema>;
export type RepairContinuationStateV1 = z.infer<typeof repairContinuationStateV1Schema>;
export type RepairContinuationOperationV1 = z.infer<typeof repairContinuationOperationV1Schema>;
export type RepairSourceIdentityV1 = z.infer<typeof repairSourceIdentityV1Schema>;
export type RepairImageIdentityV1 = z.infer<typeof repairImageIdentityV1Schema>;
export type EnvironmentQualificationBindingV1 = z.infer<
  typeof environmentQualificationBindingV1Schema
>;
export type EnvironmentQualificationOutcome = z.infer<typeof environmentQualificationOutcomeSchema>;
export type EnvironmentQualificationObservationV1 = z.infer<
  typeof environmentQualificationObservationV1Schema
>;
export type EnvironmentQualificationEvidenceV1 = z.infer<
  typeof environmentQualificationEvidenceV1Schema
>;
export type RepairCodingFinalSourceV1 = z.infer<typeof repairCodingFinalSourceV1Schema>;
