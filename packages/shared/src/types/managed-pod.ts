// Generated from specs/managed-pod/v1/protocol.schema.json. Do not edit.
import { z } from 'zod';
export const RouteSchema = z
  .object({
    providerAccountId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    model: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    reasoning: z.enum(['none', 'low', 'medium', 'high', 'xhigh']),
    runtime: z.enum(['codex', 'claude', 'copilot']),
    executionTarget: z.enum(['local', 'sandbox']),
  })
  .strict();
export type Route = z.infer<typeof RouteSchema>;
export const RepositoryScopeSchema = z
  .object({
    enrollmentId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    remote: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    baseRevision: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    access: z.enum(['read', 'write']),
    branchNamespace: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type RepositoryScope = z.infer<typeof RepositoryScopeSchema>;
export const IdentityBindingSchema = z
  .object({
    alias: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    bindingDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type IdentityBinding = z.infer<typeof IdentityBindingSchema>;
export const HardTokenBudgetSchema = z
  .object({
    expiresAt: z.number().int().min(0).max(9007199254740991),
    maxTokens: z.number().int().min(0).max(9007199254740991),
    maxDurationSeconds: z.number().int().min(0).max(9007199254740991),
  })
  .strict();
export type HardTokenBudget = z.infer<typeof HardTokenBudgetSchema>;
export const RequestTimeBudgetSchema = z
  .object({
    mode: z.literal('request-time'),
    expiresAt: z.number().int().min(0).max(9007199254740991),
    maxProviderRequests: z.number().int().min(1).max(1),
    maxDurationSeconds: z.number().int().min(1).max(180),
  })
  .strict();
export type RequestTimeBudget = z.infer<typeof RequestTimeBudgetSchema>;
export const BudgetSchema = z.union([HardTokenBudgetSchema, RequestTimeBudgetSchema]);
export type Budget = z.infer<typeof BudgetSchema>;
export const NetworkScopeSchema = z
  .object({
    profileId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    destinations: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
          .refine(
            (value) =>
              !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
                value,
              ),
            'secret-material-forbidden',
          ),
      )
      .max(5000),
  })
  .strict();
export type NetworkScope = z.infer<typeof NetworkScopeSchema>;
export const ScopeSchema = z
  .object({
    repositories: z.array(RepositoryScopeSchema).max(5000),
    network: NetworkScopeSchema,
    identityBindings: z.array(IdentityBindingSchema).max(5000),
    allowedEffects: z
      .array(
        z.enum([
          'repository.read',
          'repository.write',
          'test.run',
          'artifact.write',
          'web.public-read',
          'git.commit',
          'git.push.worker-branch',
          'pull-request.create-draft',
          'pull-request.update-draft',
        ]),
      )
      .max(5000),
  })
  .strict();
export type Scope = z.infer<typeof ScopeSchema>;
export const EffectiveGrantSchema = z
  .object({
    schemaVersion: z.literal(1),
    grantId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    revision: z.number().int().min(1),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    profileSnapshotDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    route: RouteSchema,
    scope: ScopeSchema,
    budget: BudgetSchema,
    digest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type EffectiveGrant = z.infer<typeof EffectiveGrantSchema>;
export const ProfileSnapshotSchema = z
  .object({
    profileId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    profileVersion: z.number().int().min(1),
    snapshotDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    route: RouteSchema,
    scope: ScopeSchema,
    budget: BudgetSchema,
  })
  .strict();
export type ProfileSnapshot = z.infer<typeof ProfileSnapshotSchema>;
export const ArtifactOutputSchema = z
  .object({
    mode: z.enum(['none', 'optional', 'required']),
    root: z.literal('/output'),
    requiredPaths: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
          .refine(
            (value) =>
              !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
                value,
              ),
            'secret-material-forbidden',
          ),
      )
      .max(5000),
    include: z
      .array(
        z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (value) =>
              !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
                value,
              ),
            'secret-material-forbidden',
          ),
      )
      .max(5000),
    exclude: z
      .array(
        z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (value) =>
              !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
                value,
              ),
            'secret-material-forbidden',
          ),
      )
      .max(5000),
    limits: z
      .object({
        maxFiles: z.number().int().min(0).max(9007199254740991),
        maxFileBytes: z.number().int().min(0).max(9007199254740991),
        maxTotalBytes: z.number().int().min(0).max(9007199254740991),
      })
      .strict(),
    links: z.object({ allowSymlinks: z.literal(false), allowHardlinks: z.literal(false) }).strict(),
  })
  .strict();
export type ArtifactOutput = z.infer<typeof ArtifactOutputSchema>;
export const SourceOutputSchema = z
  .object({
    mode: z.enum(['none', 'commit', 'branch', 'draft-pr']),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    remote: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    head: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    base: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type SourceOutput = z.infer<typeof SourceOutputSchema>;
export const ArtifactInputSchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    backendArtifactId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    manifestSha256: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    mountPath: z
      .string()
      .regex(/^\/inputs\/[A-Za-z0-9_-]+$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    access: z.literal('read'),
  })
  .strict();
export type ArtifactInput = z.infer<typeof ArtifactInputSchema>;
export const ManagedPodRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    managedMode: z.literal(true),
    dispatcherJobId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    startKey: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    executionSpecDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    profileSnapshot: ProfileSnapshotSchema,
    effectiveGrant: EffectiveGrantSchema,
    task: z
      .object({
        kind: z.enum([
          'research',
          'planning',
          'implementation',
          'verification',
          'review',
          'report',
          'custom',
        ]),
        objective: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (value) =>
              !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
                value,
              ),
            'secret-material-forbidden',
          ),
        contextBundleDigest: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .refine(
            (value) =>
              !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
                value,
              ),
            'secret-material-forbidden',
          ),
      })
      .strict(),
    route: RouteSchema,
    outputs: z.object({ source: SourceOutputSchema, artifacts: ArtifactOutputSchema }).strict(),
    inputArtifacts: z.array(ArtifactInputSchema).max(5000),
    validation: z
      .object({
        suite: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
          .refine(
            (value) =>
              !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
                value,
              ),
            'secret-material-forbidden',
          ),
        verifierPolicy: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
          .refine(
            (value) =>
              !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
                value,
              ),
            'secret-material-forbidden',
          ),
      })
      .strict(),
  })
  .strict();
export type ManagedPodRequest = z.infer<typeof ManagedPodRequestSchema>;
export const ManagedPodHandleSchema = z
  .object({
    schemaVersion: z.literal(1),
    podId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    dispatcherInstallationId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    acceptedExecutionSpecDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    profileSnapshotDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    grantId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    grantRevision: z.number().int().min(1),
    effectiveGrantDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    route: RouteSchema,
    createdAt: z.number().int().min(0).max(9007199254740991),
    initialCursor: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type ManagedPodHandle = z.infer<typeof ManagedPodHandleSchema>;
export const ArtifactFileSchema = z
  .object({
    path: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    size: z.number().int().min(0).max(9007199254740991),
    sha256: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    mediaType: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type ArtifactFile = z.infer<typeof ArtifactFileSchema>;
export const ArtifactManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    podId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    executionSpecDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    createdAt: z.number().int().min(0).max(9007199254740991),
    files: z.array(ArtifactFileSchema).max(5000),
    fileCount: z.number().int().min(0).max(9007199254740991),
    totalBytes: z.number().int().min(0).max(9007199254740991),
    bundle: z
      .object({
        format: z.literal('tar.gz'),
        size: z.number().int().min(0).max(9007199254740991),
        sha256: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .refine(
            (value) =>
              !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
                value,
              ),
            'secret-material-forbidden',
          ),
      })
      .strict(),
  })
  .strict();
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export const ArtifactReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    podId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    executionSpecDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    manifestSha256: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    bundleSha256: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    fileCount: z.number().int().min(0).max(9007199254740991),
    totalBytes: z.number().int().min(0).max(9007199254740991),
    status: z.literal('committed'),
  })
  .strict();
export type ArtifactReceipt = z.infer<typeof ArtifactReceiptSchema>;
export const SourceCandidateReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidateId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    podId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    executionSpecDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    remote: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    head: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    base: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    expectedOldCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    newCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    evidenceDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    candidateDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type SourceCandidateReceipt = z.infer<typeof SourceCandidateReceiptSchema>;
export const VerificationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    verificationId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    executionSpecDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    candidateDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    newCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    evidenceDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    verifierPolicy: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    verifierIdentity: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    status: z.enum(['passed', 'failed']),
    verifiedAt: z.number().int().min(0).max(9007199254740991),
    receiptDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type VerificationReceipt = z.infer<typeof VerificationReceiptSchema>;
export const FinalizeSourceDeliveryRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    dispatcherInstallationId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    executionSpecDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    candidateDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    verificationReceipt: VerificationReceiptSchema,
    grantId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    grantRevision: z.number().int().min(1),
    operation: z.enum(['commit', 'branch', 'draft-pr']),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    remote: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    head: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    base: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    expectedOldCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    newCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    draft: z.literal(true),
    bodyDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    operationKey: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type FinalizeSourceDeliveryRequest = z.infer<typeof FinalizeSourceDeliveryRequestSchema>;
export const SourceDeliveryReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    executionSpecDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    candidateDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    verificationReceiptDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    operationKey: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    requestDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    operation: z.enum(['commit', 'branch', 'draft-pr']),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    remote: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    head: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    base: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    oldCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    newCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    draft: z.literal(true),
    bodyDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    pullRequestId: z.number().int().min(0),
    status: z.literal('delivered'),
  })
  .strict();
export type SourceDeliveryReceipt = z.infer<typeof SourceDeliveryReceiptSchema>;
export const FinalizeSourceDeliveryResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(['delivered', 'pending', 'rejected']),
    receipts: z.array(SourceDeliveryReceiptSchema).max(5000),
    reason: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type FinalizeSourceDeliveryResponse = z.infer<typeof FinalizeSourceDeliveryResponseSchema>;
export const ValidationEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    kind: z.enum(['worker-claim', 'runtime-fact', 'validation', 'limitation']),
    name: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    status: z.enum(['passed', 'failed', 'observed', 'not-run']),
    digest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type ValidationEvidence = z.infer<typeof ValidationEvidenceSchema>;
export const ManagedPodEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    podId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    kind: z.enum([
      'queued',
      'provisioning',
      'running',
      'awaiting_input',
      'paused',
      'validating',
      'validated',
      'review_required',
      'failed',
      'killing',
      'killed',
      'complete',
      'revoked',
      'cleanup',
      'follow-up',
    ]),
    createdAt: z.number().int().min(0).max(9007199254740991),
    evidence: z.array(ValidationEvidenceSchema).max(5000),
  })
  .strict();
export type ManagedPodEvent = z.infer<typeof ManagedPodEventSchema>;
export const ManagedPodResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    handle: ManagedPodHandleSchema,
    state: z.enum([
      'queued',
      'provisioning',
      'running',
      'awaiting_input',
      'paused',
      'validating',
      'validated',
      'review_required',
      'failed',
      'killing',
      'killed',
      'complete',
    ]),
    artifacts: z.array(ArtifactReceiptSchema).max(5000),
    candidates: z.array(SourceCandidateReceiptSchema).max(5000),
    source: z.array(SourceDeliveryReceiptSchema).max(5000),
    evidence: z.array(ValidationEvidenceSchema).max(5000),
    limitations: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
          .refine(
            (value) =>
              !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
                value,
              ),
            'secret-material-forbidden',
          ),
      )
      .max(5000),
    revoked: z.boolean(),
    observedExit: z.boolean(),
    cleanup: z.enum(['not-requested', 'requested', 'observed']),
  })
  .strict();
export type ManagedPodResult = z.infer<typeof ManagedPodResultSchema>;
export const ManagedPodErrorSchema = z
  .object({
    schemaVersion: z.literal(1),
    code: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    retryable: z.boolean(),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type ManagedPodError = z.infer<typeof ManagedPodErrorSchema>;
export const DriverHealthSchema = z
  .object({
    schemaVersion: z.literal(1),
    backendId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    protocol: z.literal('managed-pod-v1'),
    build: z.number().int().min(0).max(9007199254740991),
    minimumDispatcherBuild: z.number().int().min(0).max(9007199254740991),
    minimumAutoPodBuild: z.number().int().min(0).max(9007199254740991),
    capabilities: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
          .refine(
            (value) =>
              !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
                value,
              ),
            'secret-material-forbidden',
          ),
      )
      .max(5000),
    targets: z.array(z.enum(['local', 'sandbox'])).max(5000),
    enabled: z.boolean(),
  })
  .strict();
export type DriverHealth = z.infer<typeof DriverHealthSchema>;
export const FollowUpEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    grantId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    grantRevision: z.number().int().min(1),
    message: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
  })
  .strict();
export type FollowUpEnvelope = z.infer<typeof FollowUpEnvelopeSchema>;
export const ControlRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    dispatcherAttemptId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    grantId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    grantRevision: z.number().int().min(1),
    operation: z.enum(['stop', 'pause', 'resume', 'revoke', 'cleanup']),
  })
  .strict();
export type ControlRequest = z.infer<typeof ControlRequestSchema>;
export const ControlResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    accepted: z.boolean(),
    revoked: z.boolean(),
    stopRequested: z.boolean(),
    observedExit: z.boolean(),
    cleanup: z.enum(['not-requested', 'requested', 'observed']),
  })
  .strict();
export type ControlResult = z.infer<typeof ControlResultSchema>;
export const ManagedObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/)
      .refine(
        (value) =>
          !/(Bearer\s+[A-Za-z0-9._~-]+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\/\s]+:[^\/\s]+@|[?&](?:sig|token|access_token)=)/.test(
            value,
          ),
        'secret-material-forbidden',
      ),
    events: z.array(ManagedPodEventSchema).max(100),
    result: ManagedPodResultSchema,
  })
  .strict();
export type ManagedObservation = z.infer<typeof ManagedObservationSchema>;
