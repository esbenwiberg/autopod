import {
  type EffectiveLaunchConfig,
  type PimSelection,
  type ResolvedGitHubRule,
  configurationIdSchema,
  githubOperationSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { pimAssignmentKey } from '../pim/activation-repository.js';
import { configurationError } from './configuration-store.js';

const identifiers = z
  .array(configurationIdSchema)
  .max(10_000)
  .refine((v) => new Set(v).size === v.length, 'Duplicate IDs')
  .default([]);
export const configurationSecurityPolicySchema = z
  .object({
    suspended: z.boolean().default(false),
    blockedRepositoryIds: identifiers,
    blockedGitHubRepositoryIds: identifiers,
    blockedGitHubOperations: z.array(githubOperationSchema).default([]),
    blockedProviderAccountIds: identifiers,
    blockedCredentialIds: identifiers,
    blockedPimAssignments: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
  })
  .strict();
export interface ConfigurationSecurityPolicy {
  revision: number;
  payload: z.infer<typeof configurationSecurityPolicySchema>;
  updatedAt: string;
}

/** Operator policy can only subtract from a frozen launch. It cannot introduce new grants. */
export class ConfigurationSecurityPolicyStore {
  constructor(private readonly db: Database.Database) {}
  get(): ConfigurationSecurityPolicy {
    const row = this.db
      .prepare(
        'SELECT revision,payload,updated_at FROM configuration_security_policy WHERE singleton=1',
      )
      .get() as { revision: number; payload: string; updated_at: string } | undefined;
    if (!row)
      configurationError(
        'Operator security policy is unavailable',
        'CONFIG_POLICY_UNAVAILABLE',
        503,
      );
    return {
      revision: row.revision,
      payload: configurationSecurityPolicySchema.parse(JSON.parse(row.payload)),
      updatedAt: row.updated_at,
    };
  }
  write(raw: unknown, expectedRevision: number, actorId: string): ConfigurationSecurityPolicy {
    const payload = configurationSecurityPolicySchema.parse(raw);
    z.number().int().positive().parse(expectedRevision);
    z.string().trim().min(1).max(256).parse(actorId);
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const serialized = JSON.stringify(payload);
      const result = this.db
        .prepare(
          'UPDATE configuration_security_policy SET revision=revision+1,payload=?,updated_at=? WHERE singleton=1 AND revision=?',
        )
        .run(serialized, now, expectedRevision);
      if (result.changes !== 1)
        configurationError('Operator policy changed before saving', 'CONFIG_POLICY_CHANGED', 409);
      this.db
        .prepare('INSERT INTO configuration_security_policy_history VALUES(?,?,?,?)')
        .run(expectedRevision + 1, serialized, actorId, now);
      return this.get();
    })();
  }
  assertLaunch(config: EffectiveLaunchConfig): void {
    const policy = this.get().payload;
    if (policy.suspended)
      configurationError(
        'Composable execution is suspended by the operator',
        'CONFIG_POLICY_SUSPENDED',
        403,
      );
    if (
      [config.repository?.id, ...config.references.map((entry) => entry.id)].some(
        (id) => id && policy.blockedRepositoryIds.includes(id),
      )
    )
      configurationError(
        'A selected repository was revoked by the operator',
        'CONFIG_REPOSITORY_REVOKED',
        403,
      );
    if (
      Object.keys(config.agentAccounts).some((id) => policy.blockedProviderAccountIds.includes(id))
    )
      configurationError(
        'A selected AI account was revoked by the operator',
        'CONFIG_ACCOUNT_REVOKED',
        403,
      );
    if (
      Object.keys(config.credentialReferences).some((id) =>
        policy.blockedCredentialIds.includes(id),
      )
    )
      configurationError(
        'A selected service credential was revoked by the operator',
        'CONFIG_CREDENTIAL_REVOKED',
        403,
      );
    for (const selection of config.pim) this.assertPimAllowed(selection);
  }
  assertPimAllowed(selection: PimSelection): void {
    const policy = this.get().payload;
    if (policy.suspended || policy.blockedPimAssignments.includes(pimAssignmentKey(selection)))
      configurationError(
        'This PIM assignment was revoked by the operator',
        'PIM_POLICY_REVOKED',
        403,
      );
  }
  githubCeiling(config: EffectiveLaunchConfig): ResolvedGitHubRule[] {
    this.assertLaunch(config);
    const policy = this.get().payload;
    return config.githubAccess.map((bound) => ({
      ...structuredClone(bound),
      repositoryIds: bound.repositoryIds.filter(
        (id) => !policy.blockedGitHubRepositoryIds.includes(id),
      ),
      rule: {
        ...structuredClone(bound.rule),
        operations: bound.rule.operations.filter(
          (operation) => !policy.blockedGitHubOperations.includes(operation),
        ),
      },
    }));
  }
}
