import { randomUUID } from 'node:crypto';
import type { JwtPayload } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { configurationError } from '../configuration/configuration-store.js';
import { canonical, digest } from '../managed/canonical.js';

const id = z.string().min(1).max(160);
export const delegationPin = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const alias = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const portableFile = z
  .string()
  .max(160)
  .refine((file) =>
    file
      .split('/')
      .every((part) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) && !part.endsWith('.')),
  );

const codingRole = z
  .object({
    role: alias,
    recipeId: alias,
    recipeRevision: z.number().int().positive(),
    recipeDigest: delegationPin,
    accountId: id,
    files: z.array(portableFile).min(1).max(16),
    modelRequests: z.number().int().min(1).max(64),
    observedTokenStop: z.number().int().min(1).max(1_000_000),
    wallSeconds: z.number().int().min(1).max(900),
  })
  .strict();

export const savedDelegationPolicySchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(120),
    repositoryId: id,
    repositoryRevision: z.number().int().positive(),
    sourceBranch: z
      .string()
      .max(160)
      .refine(
        (branch) =>
          !branch.includes('..') &&
          branch
            .split('/')
            .every(
              (part) =>
                /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) &&
                !part.endsWith('.') &&
                !part.toLowerCase().endsWith('.lock'),
            ),
      ),
    // This first contract is deliberately the current two-worker exact-tree workflow.
    workers: z.tuple([codingRole, codingRole]),
    maxConcurrentWorkers: z.number().int().min(1).max(2),
    checksDigest: delegationPin,
    reviewer: z
      .object({
        accountId: id,
        tokenBudget: z.number().int().min(1).max(128_000),
        policyDigest: delegationPin,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const paths = value.workers.flatMap((worker) => worker.files.map((file) => file.toLowerCase()));
    if (
      value.workers[0].role === value.workers[1].role ||
      value.workers.some((worker) => worker.accountId === value.reviewer.accountId) ||
      paths.some((file, i) =>
        paths.some((other, j) => i !== j && (file === other || file.startsWith(other + '/'))),
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['workers'],
        message:
          'Delegation needs distinct roles, disjoint file scopes and an independent reviewer',
      });
  });

export type SavedDelegationPolicy = z.infer<typeof savedDelegationPolicySchema>;
export type DelegationPrincipal = Pick<JwtPayload, 'oid' | 'iss' | 'aud' | 'operatorPrincipal'>;

export function delegationOwnerDigest(principal: DelegationPrincipal) {
  if (
    principal.operatorPrincipal !== 'delegated-user' ||
    ![principal.oid, principal.iss, principal.aud].every(
      (part) => typeof part === 'string' && !!part.trim() && part.length <= 512,
    )
  )
    configurationError(
      'Saved delegation requires an authenticated human',
      'DELEGATION_OWNER_REQUIRED',
      403,
    );
  return digest(['saved-delegation-owner/v1', principal.oid, principal.iss, principal.aud]);
}

interface PolicyRow {
  policy_id: string;
  revision: number;
  payload: string;
  payload_digest: string;
}

export function createSavedDelegationPolicyStore(db: Database.Database) {
  const current = db.prepare(`SELECT policy_id,revision,payload,payload_digest
    FROM saved_delegation_policy_revisions WHERE owner_digest=? AND policy_id=? ORDER BY revision DESC LIMIT 1`);
  const insert = db.prepare(`INSERT INTO saved_delegation_policy_revisions
    (owner_digest,policy_id,revision,payload,payload_digest) VALUES(?,?,?,?,?)`);
  function decode(row: PolicyRow) {
    const policy = savedDelegationPolicySchema.parse(JSON.parse(row.payload));
    if (digest(policy) !== row.payload_digest)
      configurationError(
        'Saved delegation policy failed integrity check',
        'DELEGATION_POLICY_CORRUPT',
        500,
      );
    return {
      policyId: row.policy_id,
      revision: row.revision,
      policyDigest: row.payload_digest,
      policy,
    };
  }
  function get(owner: string, id: string) {
    const row = current.get(owner, id) as PolicyRow | undefined;
    if (!row)
      configurationError('Saved delegation policy not found', 'DELEGATION_POLICY_NOT_FOUND', 404);
    return decode(row);
  }
  function put(owner: string, id: string, revision: number, raw: unknown) {
    const parsed = savedDelegationPolicySchema.safeParse(raw);
    if (!parsed.success)
      configurationError(
        'Invalid or unsupported delegation policy',
        'DELEGATION_POLICY_INVALID',
        400,
      );
    const policy = parsed.data;
    const policyDigest = digest(policy);
    insert.run(owner, id, revision, canonical(policy), policyDigest);
    return { policyId: id, revision, policyDigest, policy };
  }
  return {
    usesDatabase(candidate: Database.Database) {
      return db === candidate;
    },
    /** Host-owned idempotent install; never overwrite a reviewed policy at boot. */
    installPilot(principal: DelegationPrincipal, policyId: string, raw: unknown) {
      const owner = delegationOwnerDigest(principal);
      const policy = savedDelegationPolicySchema.parse(raw);
      const id = z.uuid().parse(policyId);
      return db
        .transaction(() => {
          const row = current.get(owner, id) as PolicyRow | undefined;
          if (!row) return put(owner, id, 1, policy);
          const saved = decode(row);
          if (saved.policyDigest !== digest(policy))
            throw new Error('saved-delegation-pilot-policy-changed');
          return saved;
        })
        .immediate();
    },
    create(principal: DelegationPrincipal, raw: unknown) {
      const owner = delegationOwnerDigest(principal);
      return put(owner, randomUUID(), 1, raw);
    },
    listCurrent(principal: DelegationPrincipal, repositoryId: string) {
      const owner = delegationOwnerDigest(principal);
      const rows = db
        .prepare(`SELECT r.policy_id,r.revision,r.payload,r.payload_digest
        FROM saved_delegation_policy_revisions r JOIN (
          SELECT policy_id,max(revision) AS revision FROM saved_delegation_policy_revisions
          WHERE owner_digest=? GROUP BY policy_id
        ) latest ON latest.policy_id=r.policy_id AND latest.revision=r.revision
        WHERE r.owner_digest=? AND json_extract(r.payload,'$.repositoryId')=?
        ORDER BY r.policy_id LIMIT 64`)
        .all(owner, owner, repositoryId) as PolicyRow[];
      return rows.map((row) => {
        const { policyId, revision, policy } = decode(row);
        return { policyId, revision, name: policy.name, repositoryId: policy.repositoryId };
      });
    },
    readCurrent(principal: DelegationPrincipal, policyId: string, revision?: number) {
      const saved = get(delegationOwnerDigest(principal), policyId);
      if (revision !== undefined && saved.revision !== revision)
        configurationError(
          'Delegation policy changed; select the current revision',
          'DELEGATION_POLICY_CHANGED',
          409,
        );
      return saved;
    },
    revise(
      principal: DelegationPrincipal,
      policyId: string,
      expectedRevision: number,
      raw: unknown,
    ) {
      const owner = delegationOwnerDigest(principal);
      return db
        .transaction(() => {
          const saved = get(owner, policyId);
          if (saved.revision !== expectedRevision)
            configurationError(
              'Delegation policy changed; reload it before saving',
              'DELEGATION_POLICY_CHANGED',
              409,
            );
          return put(owner, policyId, expectedRevision + 1, raw);
        })
        .immediate();
    },
  };
}

export type SavedDelegationPolicyStore = ReturnType<typeof createSavedDelegationPolicyStore>;
