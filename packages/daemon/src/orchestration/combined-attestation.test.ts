import { expect, it } from 'vitest';
import { digest } from '../managed/canonical.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import { combinedPolicyDigest, verifyGateReceipt } from './combined-attestation.js';

function fixture() {
  const checker = fixtureSigner('checks', 'checker', digest('checks-v1'));
  const reviewer = fixtureSigner('independentReview', 'reviewer', digest('review-v1'));
  const policy = {
    basePolicyDigest: digest('base'),
    checks: checker.authority,
    independentReview: reviewer.authority,
  };
  const result = {
    status: 'passed' as const,
    inputDigest: digest('subject and ordered inputs'),
    evidenceDigest: digest('evidence'),
  };
  return { checker, reviewer, policy, result };
}
it('pins both configurations and rejects a shared signer even under two names', () => {
  const { policy } = fixture();
  const hash = combinedPolicyDigest(policy);
  for (const role of ['checks', 'independentReview'] as const) {
    expect(
      combinedPolicyDigest({
        ...policy,
        [role]: { ...policy[role], configurationDigest: digest('v2') },
      }),
    ).not.toBe(hash);
  }
  expect(() =>
    combinedPolicyDigest({
      ...policy,
      checks: { ...policy.checks, publicKey: policy.independentReview.publicKey },
    }),
  ).toThrow();
  expect(() =>
    combinedPolicyDigest({
      ...policy,
      checks: { ...policy.checks, identity: policy.independentReview.identity },
    }),
  ).toThrow();
});
it('rejects a valid signature for a different evaluator configuration, role or input', () => {
  const { checker, reviewer, policy, result } = fixture();
  const receipt = reviewer.attest(result);
  const verify = (raw: unknown) =>
    verifyGateReceipt(policy, 'independentReview', result.inputDigest, raw);
  expect(verify(receipt).receiptDigest).toBe(digest(receipt));
  expect(() =>
    verifyGateReceipt(
      {
        ...policy,
        independentReview: {
          ...policy.independentReview,
          configurationDigest: digest('other config'),
        },
      },
      'independentReview',
      result.inputDigest,
      receipt,
    ),
  ).toThrow('combined-independentReview-required');
  expect(() => verify(checker.attest(result))).toThrow('combined-independentReview-required');
  expect(() =>
    verify(reviewer.attest({ ...result, inputDigest: digest('other subject') })),
  ).toThrow('combined-independentReview-required');
  expect(() =>
    verify({ ...receipt, statement: { ...receipt.statement, evidenceDigest: digest('changed') } }),
  ).toThrow('combined-independentReview-required');
  expect(() => verify({ ...receipt, publicKey: policy.checks.publicKey })).toThrow(
    'combined-independentReview-required',
  );
});
