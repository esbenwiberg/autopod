import { isIP } from 'node:net';
import { z } from 'zod';
import { canonical, sha256 } from '../managed/canonical.js';
import { MAX_PRIVATE_HEAD_BYTES } from '../managed/private-head-export.js';
import type { CombinedPolicy, Role } from './combined-attestation.js';
import { signedGateSchema } from './combined-attestation.js';
import type { EvaluatorDispatchSigner } from './parent-evaluator-dispatch.js';
import {
  type ParentIntegrationGates,
  parentIntegrationGateDigest,
} from './parent-integration-qualified.js';
import { brokeredReviewDeadlineMs } from './parent-review-broker.js';

const endpoint = z
  .string()
  .max(512)
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return (
        url.href === raw &&
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !url.port &&
        url.hostname.includes('.') &&
        !isIP(url.hostname) &&
        !url.hostname.endsWith('.') &&
        url.pathname !== '/'
      );
    } catch {
      return false;
    }
  });
const dnsEndpoints = z
  .object({
    checks: endpoint,
    independentReview: endpoint,
  })
  .strict()
  .refine((value) => new URL(value.checks).hostname !== new URL(value.independentReview).hostname);

/** An explicitly configured same-host pair. No DNS, public ingress, arbitrary
 * ports, or mixing one local role with a remote role. Each still uses mTLS. */
export const localEvaluatorEndpoints = {
  checks: 'https://127.0.0.1:18443/verify',
  independentReview: 'https://127.0.0.1:19443/verify',
} as const;

export const parentEvaluatorEndpointsSchema = z.union([
  dnsEndpoints,
  z
    .object({
      checks: z.literal(localEvaluatorEndpoints.checks),
      independentReview: z.literal(localEvaluatorEndpoints.independentReview),
    })
    .strict(),
]);
export type ParentEvaluatorEndpoints = z.infer<typeof parentEvaluatorEndpointsSchema>;

const maxResponseBytes = 2048;
const maxSourceBytes = 2 * MAX_PRIVATE_HEAD_BYTES;
const timeoutMs = 30_000;

export function createParentEvaluatorClient(
  endpoints: ParentEvaluatorEndpoints,
  policy: CombinedPolicy,
  fetchPort: typeof fetch = fetch,
  authorize?: EvaluatorDispatchSigner,
  nativeReview = false,
): ParentIntegrationGates {
  const bound = parentEvaluatorEndpointsSchema.parse(endpoints);
  const call =
    (role: Role): ParentIntegrationGates[Role] =>
    async (request, bundle) => {
      const metadata = canonical(request);
      if (
        !bundle.length ||
        bundle.length > maxSourceBytes ||
        Buffer.byteLength(metadata) > 8192 ||
        sha256(bundle) !== request.bundleDigest
      )
        throw new Error('parent-evaluator-request-bound');
      const response = await fetchPort(bound[role], {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(
          nativeReview && role === 'independentReview' ? brokeredReviewDeadlineMs : timeoutMs,
        ),
        body: JSON.stringify({
          request,
          bundle: bundle.toString('base64'),
          ...(authorize ? { dispatch: authorize(role, parentIntegrationGateDigest(request)) } : {}),
        }),
      });
      try {
        if (
          response.status !== 200 ||
          !response.body ||
          response.redirected ||
          !/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? '')
        )
          throw new Error('parent-evaluator-response-unavailable');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let count = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            count += value.byteLength;
            if (count > maxResponseBytes) throw new Error('parent-evaluator-response-bound');
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        return signedGateSchema.parse(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, count)),
          ),
        );
      } finally {
        if (response.body) void response.body.cancel().catch(() => {});
      }
    };
  return {
    policy: structuredClone(policy),
    checks: call('checks'),
    independentReview: call('independentReview'),
  };
}
