import type Database from 'better-sqlite3';
import type { CombinedPolicy } from './combined-attestation.js';
import { assertParentIntegrationBinding } from './parent-candidate-integration.js';
import {
  type ParentEvaluatorPorts,
  parentExactTreeEvaluator,
} from './parent-exact-tree-evaluator.js';
import {
  type ParentIntegrationGates,
  parentIntegrationGateDigest,
  parentIntegrationGateRequestSchema,
} from './parent-integration-qualified.js';
import { parentIsolatedReview } from './parent-isolated-review.js';

type ReviewOptions = Parameters<typeof parentIsolatedReview>[0];

export interface ParentHostGatePorts {
  /** Local receipts are permitted only by an explicit signed candidate mode. */
  receiptTrust?: 'single-owner-local';
  checks: ParentEvaluatorPorts;
  review: Pick<ReviewOptions, 'readPod' | 'readLaunch' | 'reviewer' | 'sign'>;
}

/** Explicit daemon composition, not an HTTP route or a default signing authority. */
export function composeParentHostGates(
  binding: {
    db: Database.Database;
    scratch: string;
    run: string;
    policy: CombinedPolicy;
    excludedReviewerAccounts: readonly string[];
  },
  ports: ParentHostGatePorts,
): ParentIntegrationGates {
  const { db, scratch, run } = binding;
  const policy = structuredClone(binding.policy);
  const { evaluate, sign } = ports.checks;
  // Reject accidental callback reuse; actual verification separately requires
  // distinct enrolled public keys and validates both role-bound receipts.
  if (
    typeof evaluate !== 'function' ||
    typeof sign !== 'function' ||
    typeof ports.review.sign !== 'function' ||
    sign === ports.review.sign
  )
    throw new Error('parent-host-evaluator-ports-required');
  const current = db.prepare(`SELECT 1 FROM parent_qualification_jobs
    WHERE run_id=? AND status='checks' AND input_digest=?`);
  // A subordinate port must not retry either. Durable dispatch ownership and
  // boot fencing are held by parentQualificationJob, not this closure.
  let consumed = false;
  return {
    policy,
    checks: async (raw, bundle) => {
      const request = parentIntegrationGateRequestSchema.parse(raw);
      const digest = parentIntegrationGateDigest(request);
      const assertCurrent = () => {
        if (request.subject.run !== run || !current.get(run, digest))
          throw new Error('parent-checks-claim-required');
        assertParentIntegrationBinding(db, run, request.inputs, request.bindingDigest);
      };
      assertCurrent();
      if (consumed) throw new Error('parent-checks-already-claimed');
      consumed = true;
      return parentExactTreeEvaluator(scratch, policy, 'checks', {
        async evaluate(selection) {
          assertCurrent();
          const result = await evaluate(selection);
          assertCurrent();
          return result;
        },
        async sign(statement) {
          assertCurrent();
          const receipt = await sign(statement);
          assertCurrent();
          return receipt;
        },
      })(request, bundle);
    },
    independentReview: parentIsolatedReview({
      ...ports.review,
      ...binding,
      policy,
    }),
  };
}
