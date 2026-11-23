import { z } from 'zod';
import { digest } from '../managed/canonical.js';
import type { Role } from './combined-attestation.js';
import type { ParentEvaluatorEndpoints } from './parent-evaluator-client.js';
import {
  type EvaluatorDispatchSigner,
  evaluatorDispatchSchema,
} from './parent-evaluator-dispatch.js';

export const evaluatorReadinessSchema = z
  .object({
    readiness: z
      .object({
        run: z.string().regex(/^[a-f0-9]{64}$/),
        repository: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        predecessor: z.string().regex(/^[a-f0-9]{40}$/),
        policyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        paths: z.array(z.string().min(1).max(160)).min(1).max(32),
      })
      .strict(),
    dispatch: evaluatorDispatchSchema,
  })
  .strict();
type Binding = z.infer<typeof evaluatorReadinessSchema>['readiness'];
export const readinessDigest = (binding: Binding) =>
  digest(['autopod.evaluator-readiness/v1', binding]);

/** Read-only lease check; no source bundle, evaluation or receipt. Authenticated
 * transport is required from the host (same distinct mTLS ports as /verify). */
export async function requireEvaluatorReadiness(
  endpoints: ParentEvaluatorEndpoints,
  transport: typeof fetch,
  sign: EvaluatorDispatchSigner,
  binding: Binding,
) {
  const expected = readinessDigest(binding);
  for (const role of ['checks', 'independentReview'] as const satisfies readonly Role[]) {
    const response = await transport(endpoints[role], {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ readiness: binding, dispatch: sign(role, expected) }),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || response.redirected)
      throw new Error('saved-delegation-evaluator-lease-not-ready');
    const answer = z
      .object({ ready: z.literal(true), bindingDigest: z.literal(expected) })
      .strict()
      .parse(await response.json());
    if (!answer.ready) throw new Error('saved-delegation-evaluator-lease-not-ready');
  }
}
