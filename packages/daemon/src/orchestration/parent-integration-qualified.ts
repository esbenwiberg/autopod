import type Database from 'better-sqlite3';
import { digest } from '../managed/canonical.js';
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

export interface ParentIntegrationGateRequest {
  subject: Omit<ContinuationCheckpoint, 'evidenceDigest'>;
  inputs: readonly {
    requestKey: string;
    candidateDigest: string;
    expectedTree: string;
    scopeDigest: string;
  }[];
  paths: readonly string[];
  bindingDigest: string;
  bundleDigest: string;
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

/** Host-only qualification using trusted evaluator ports. No worker or HTTP surface. */
export async function qualifyParentIntegration(
  db: Database.Database,
  host: LocalCheckpointHost,
  scratch: string,
  run: string,
  inputs: readonly [Readonly<ParentIntegrationInput>, Readonly<ParentIntegrationInput>],
  gates: ParentIntegrationGates,
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
  const request: ParentIntegrationGateRequest = {
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
  };
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
  );
}
