import { expect, it, vi } from 'vitest';
import { digest, sha256 } from '../managed/canonical.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import {
  createParentEvaluatorClient,
  localEvaluatorEndpoints,
  parentEvaluatorEndpointsSchema,
} from './parent-evaluator-client.js';
import type { ParentIntegrationGateRequest } from './parent-integration-qualified.js';

const endpoints = {
  checks: 'https://checks.fixture.example/qualify',
  independentReview: 'https://review.fixture.example/qualify',
};
const policy = {
  basePolicyDigest: digest('base'),
  checks: fixtureSigner('checks', 'fixture-checks', digest('checks')).authority,
  independentReview: fixtureSigner('independentReview', 'fixture-review', digest('review'))
    .authority,
};
const bundle = Buffer.from('fixture only');
const request = { bundleDigest: sha256(bundle) } as ParentIntegrationGateRequest;

it.each([
  'http://checks.fixture.example/qualify',
  'https://checks.fixture.example/qualify?query=present',
  'https://127.0.0.1/qualify',
  'https://review.fixture.example/another-path',
])('rejects an unenrollable endpoint: %s', (checks) => {
  expect(parentEvaluatorEndpointsSchema.safeParse({ ...endpoints, checks }).success).toBe(false);
});

it('allows only the exact paired loopback endpoints without widening DNS endpoints', () => {
  const local = localEvaluatorEndpoints;
  expect(parentEvaluatorEndpointsSchema.parse(local)).toEqual(local);
  for (const pair of [
    { ...local, checks: endpoints.checks },
    { ...local, independentReview: endpoints.independentReview },
    { checks: local.independentReview, independentReview: local.checks },
    { ...local, checks: local.checks.replace('18443', '18444') },
    { ...local, checks: local.checks.replace('127.0.0.1', '0.0.0.0') },
    { ...local, checks: local.checks.replace('127.0.0.1', 'localhost') },
    { ...local, checks: local.checks + '/extra' },
    { ...local, checks: local.checks + '?extra' },
  ])
    expect(parentEvaluatorEndpointsSchema.safeParse(pair).success).toBe(false);
});

it('bounds response bytes and does not fall back or retry', async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ padding: 'x'.repeat(3000) }));
  const client = createParentEvaluatorClient(endpoints, policy, transport);
  await expect(client.checks(request, bundle)).rejects.toThrow('parent-evaluator-response-bound');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]?.[0]).toBe(endpoints.checks);
});

it('rejects a redirect instead of consuming its response or following it', async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.redirect(endpoints.independentReview));
  await expect(
    createParentEvaluatorClient(endpoints, policy, transport).checks(request, bundle),
  ).rejects.toThrow('parent-evaluator-response-unavailable');
  expect(transport).toHaveBeenCalledTimes(1);
});
