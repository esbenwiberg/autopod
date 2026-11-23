import { canonical, sha256 } from '../managed/canonical.js';
import { MAX_CANDIDATE_BYTES } from '../managed/source-git.js';
import { type ParentDeltaSource, restoreParentSource } from './anchored-delegation-source.js';
import {
  type CombinedPolicy,
  combinedPolicyDigest,
  type GateStatement,
  gatePolicySchema,
  type Role,
  type SignedGateReceipt,
  verifyGateReceipt,
} from './combined-attestation.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';
import {
  type ParentIntegrationGateRequest,
  parentIntegrationGateDigest,
  parentIntegrationGateRequestSchema,
} from './parent-integration-qualified.js';

export interface ParentEvaluatorPorts {
  /** Trusted role-owned adapter. For executable checks, isolate the checkout and run a fixed recipe. */
  evaluate(selection: {
    mirror: string;
    commit: string;
    tree: string;
    predecessor: string;
    run: string;
    inputDigest: string;
  }): Promise<{ status: 'passed' | 'failed'; evidence: Buffer }>;
  /** Owned by the independent evaluator, not the worker or bundle importer. */
  sign(statement: GateStatement): Promise<SignedGateReceipt>;
}

export class ParentEvaluatorVeto extends Error {
  constructor(readonly role: Role) {
    super(`combined-${role}-required`);
  }
}

/** Construct on the evaluator side. Verify a private copy before running the fixed evaluation. */
export function parentExactTreeEvaluator(
  scratch: string,
  pinned: CombinedPolicy,
  role: Role,
  ports: ParentEvaluatorPorts,
  delta?: (predecessor: string) => Promise<ParentDeltaSource>,
) {
  const policy = gatePolicySchema.parse(pinned);
  const { identity, configurationDigest } = policy[role];
  const { evaluate, sign } = ports;
  return async (raw: ParentIntegrationGateRequest, source: Buffer) => {
    if (!Buffer.isBuffer(source) || !source.length || source.length > MAX_CANDIDATE_BYTES)
      throw new Error('parent-evaluator-bundle-size');
    const request = parentIntegrationGateRequestSchema.parse(raw);
    if (
      Buffer.byteLength(canonical(request)) > 8192 ||
      request.subject.policyDigest !== combinedPolicyDigest(policy)
    )
      throw new Error('parent-evaluator-policy-binding');
    if (Boolean(delta) !== (request.resultTransport === 'anchored/v1'))
      throw new Error('parent-evaluator-result-transport-mismatch');
    const bundle = Buffer.from(source);
    if (sha256(bundle) !== request.bundleDigest) throw new Error('parent-evaluator-bundle-digest');
    const { commit, tree, predecessor } = request.subject;
    const inputDigest = parentIntegrationGateDigest(request);
    const result = await restoreParentSource(
      withVerifiedCheckpointMirror,
      delta && (await delta(predecessor)),
      scratch,
      { commit, tree, predecessor },
      bundle,
      (mirror) =>
        evaluate({ mirror, commit, tree, predecessor, run: request.subject.run, inputDigest }),
    );
    const { status, evidence } = result;
    if (
      !Buffer.isBuffer(evidence) ||
      !evidence.length ||
      evidence.length > 65536 ||
      (status !== 'passed' && status !== 'failed')
    )
      throw new Error('parent-evaluator-evidence-invalid');
    if (status === 'failed') throw new ParentEvaluatorVeto(role);
    const statement = {
      role,
      identity,
      configurationDigest,
      inputDigest,
      status,
      evidenceDigest: sha256(evidence),
    };
    const receipt = await sign({ ...statement });
    if (canonical(receipt.statement) !== canonical(statement))
      throw new Error('parent-evaluator-receipt-binding');
    // An invalid or substituted signature cannot turn the result into a pass.
    return verifyGateReceipt(policy, role, inputDigest, receipt).receipt;
  };
}
