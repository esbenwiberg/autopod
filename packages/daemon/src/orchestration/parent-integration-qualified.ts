import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonical, digest, sha256 } from '../managed/canonical.js';
import { MAX_CANDIDATE_BYTES } from '../managed/source-git.js';
import {
  type CombinedPolicy,
  combinedPolicyDigest,
  gatePolicySchema,
  type Role,
  type SignedGateReceipt,
  verifyGateReceipt,
} from './combined-attestation.js';
import type { ContinuationCheckpoint } from './continuations.js';
import type { LocalCheckpointHost } from './local-checkpoints.js';
import {
  buildParentIntegration,
  type ParentIntegrationInput,
} from './parent-candidate-integration.js';

const maxGateRequestBytes = 8192;
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const subjectSchema = z
  .object({
    run: z.string().min(1).max(160),
    repository: z.string().min(1).max(160),
    predecessor: oid,
    commit: oid,
    tree: oid,
    policyDigest: sha,
  })
  .strict();
export const parentIntegrationGateRequestSchema = z
  .object({
    subject: subjectSchema,
    inputs: z
      .array(
        z
          .object({
            requestKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
            candidateDigest: sha,
            expectedTree: oid,
            scopeDigest: sha,
          })
          .strict(),
      )
      .length(2),
    paths: z.array(z.string().min(1).max(4096)).min(1).max(2048),
    bindingDigest: sha,
    bundleDigest: sha,
  })
  .strict();
export type ParentIntegrationGateRequest = z.infer<typeof parentIntegrationGateRequestSchema>;

const retainedSchema = z
  .object({
    version: z.literal(1),
    subject: subjectSchema,
    bundleDigest: sha,
    verification: z
      .object({
        subjectDigest: sha,
        gateRequest: parentIntegrationGateRequestSchema,
        inputDigest: sha,
        gatePolicy: gatePolicySchema,
        checks: z
          .object({ status: z.literal('passed'), receiptDigest: sha, receipt: z.unknown() })
          .strict(),
        independentReview: z
          .object({ status: z.literal('passed'), receiptDigest: sha, receipt: z.unknown() })
          .strict(),
      })
      .strict(),
  })
  .strict();

function requireBoundedRequest(request: ParentIntegrationGateRequest) {
  if (Buffer.byteLength(canonical(request)) > maxGateRequestBytes)
    throw new Error('parent-integration-evidence-too-large');
}

type Evaluator = (
  request: ParentIntegrationGateRequest,
  bundle: Buffer,
) => Promise<SignedGateReceipt>;

export interface ParentIntegrationGates {
  policy: CombinedPolicy;
  checks: Evaluator;
  independentReview: Evaluator;
}

/** Evaluators must verify the bundle and evaluate the actual tree before signing. */
export function parentIntegrationGateDigest(request: ParentIntegrationGateRequest) {
  return digest(['autopod.parent-integration-gate.v1', request]);
}

/** Private read-back of historical custody, not authority to advance or publish. */
export function readQualifiedParentIntegration(
  db: Database.Database,
  run: string,
  evidenceDigest: string,
) {
  sha.parse(evidenceDigest);
  const row = db
    .prepare(`SELECT r.repository, r.policy_digest,
    CASE WHEN length(CAST(c.manifest AS BLOB))<=16384 THEN c.manifest END AS manifest,
    CASE WHEN length(c.bundle) BETWEEN 1 AND ? THEN c.bundle END AS bundle
    FROM orchestration_checkpoint_custody c
    JOIN orchestration_runs r ON r.id=c.run_id
    JOIN parent_managed_runs p ON p.run_id=r.id
    WHERE c.run_id=? AND c.evidence_digest=?`)
    .get(MAX_CANDIDATE_BYTES, run, evidenceDigest) as
    | {
        repository: string;
        policy_digest: string;
        manifest: string | null;
        bundle: Buffer | null;
      }
    | undefined;
  if (!row?.manifest || !row.bundle || sha256(row.manifest) !== evidenceDigest)
    throw new Error('parent-integration-custody-unavailable');
  const { subject, bundleDigest, verification } = retainedSchema.parse(JSON.parse(row.manifest));
  const { gateRequest, gatePolicy } = verification;
  requireBoundedRequest(gateRequest);
  if (
    subject.run !== run ||
    subject.repository !== row.repository ||
    subject.policyDigest !== row.policy_digest ||
    combinedPolicyDigest(gatePolicy) !== subject.policyDigest ||
    canonical(gateRequest.subject) !== canonical(subject) ||
    verification.subjectDigest !== digest(subject) ||
    gateRequest.bundleDigest !== bundleDigest ||
    sha256(row.bundle) !== bundleDigest ||
    parentIntegrationGateDigest(gateRequest) !== verification.inputDigest
  )
    throw new Error('parent-integration-custody-binding');
  const checks = verifyGateReceipt(
    gatePolicy,
    'checks',
    verification.inputDigest,
    verification.checks.receipt,
  );
  const independentReview = verifyGateReceipt(
    gatePolicy,
    'independentReview',
    verification.inputDigest,
    verification.independentReview.receipt,
  );
  if (
    checks.receiptDigest !== verification.checks.receiptDigest ||
    independentReview.receiptDigest !== verification.independentReview.receiptDigest
  )
    throw new Error('parent-integration-custody-binding');
  return {
    checkpoint: { ...subject, evidenceDigest },
    gateRequest,
    checks,
    independentReview,
    bundle: row.bundle,
  };
}

/** Host-only qualification using trusted evaluator ports. No worker or HTTP surface. */
export async function qualifyParentIntegration(
  db: Database.Database,
  host: LocalCheckpointHost,
  scratch: string,
  run: string,
  inputs: readonly [Readonly<ParentIntegrationInput>, Readonly<ParentIntegrationInput>],
  gates: ParentIntegrationGates,
  onRetained?: (evidenceDigest: string) => void,
): Promise<ContinuationCheckpoint> {
  if (!host.usesDatabase(db)) throw new Error('parent-integration-database-mismatch');
  const policy = gatePolicySchema.parse(gates.policy);
  const policyDigest = combinedPolicyDigest(policy);
  const evaluators = { checks: gates.checks, independentReview: gates.independentReview };
  if (evaluators.checks === evaluators.independentReview)
    throw new Error('parent-integration-independent-evaluators-required');
  const binding = db.prepare(
    'SELECT repository FROM orchestration_runs WHERE id=? AND policy_digest=? AND canceled=0',
  );
  const readBinding = () => binding.get(run, policyDigest) as { repository: string } | undefined;
  const runBinding = readBinding();
  if (!runBinding) throw new Error('parent-integration-policy-mismatch');

  const integration = await buildParentIntegration(db, scratch, run, inputs);
  const assertCurrent = () => {
    if (readBinding()?.repository !== runBinding.repository)
      throw new Error('parent-integration-policy-mismatch');
    integration.assertCurrent();
  };
  const request = parentIntegrationGateRequestSchema.parse({
    subject: {
      run,
      repository: runBinding.repository,
      predecessor: integration.base,
      commit: integration.commit,
      tree: integration.tree,
      policyDigest,
    },
    inputs: integration.inputs,
    paths: integration.paths,
    bindingDigest: integration.bindingDigest,
    bundleDigest: integration.bundleDigest,
  });
  requireBoundedRequest(request);
  const inputDigest = parentIntegrationGateDigest(request);
  return host.retain(
    request.subject,
    integration.bundle,
    async (subject) => {
      const check = async (role: Role) => {
        assertCurrent();
        const receipt = await evaluators[role](
          structuredClone(request),
          Buffer.from(integration.bundle),
        );
        assertCurrent();
        return verifyGateReceipt(policy, role, inputDigest, receipt);
      };
      const checks = await check('checks');
      const independentReview = await check('independentReview');
      return {
        subjectDigest: digest(subject),
        gateRequest: request,
        inputDigest,
        gatePolicy: policy,
        checks,
        independentReview,
      };
    },
    undefined,
    // The candidate receipts, authority, and bytes are SQLite rows in this same
    // database. Re-read them under the custody write transaction. Scratch files
    // are disposable and cannot change the retained in-memory bundle.
    assertCurrent,
    onRetained,
  );
}
