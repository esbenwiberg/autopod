import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UnmeasuredUsageAcceptance } from '../../pods/unmeasured-usage-acceptance.js';

const acceptRequestSchema = z
  .object({
    reason: z.string().trim().min(10).max(2000),
    attempt: z.number().int().positive().optional(),
  })
  .strict();

/**
 * POST /pods/:podId/accept-unmeasured-usage — the pod owner's audited decision to
 * count a failed provider attempt's usage as unmeasured and continue (#646).
 * Authorization is owner-only and enforced by the service (no role bypass).
 */
export function unmeasuredUsageRoutes(
  app: FastifyInstance,
  acceptance: UnmeasuredUsageAcceptance,
): void {
  app.post<{ Params: { podId: string } }>(
    '/pods/:podId/accept-unmeasured-usage',
    async (request, reply) => {
      const parsed = acceptRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.status(400);
        return {
          error: 'A reason of 10 to 2000 characters is required; attempt must be a positive integer',
          code: 'INVALID_REQUEST',
        };
      }
      try {
        return await acceptance.accept(
          request.params.podId,
          { reason: parsed.data.reason, attemptOrdinal: parsed.data.attempt },
          { oid: request.user.oid },
        );
      } catch (err) {
        if (err instanceof AutopodError) {
          reply.status(err.statusCode ?? 400);
          return { error: err.message, code: err.code };
        }
        throw err;
      }
    },
  );
}
