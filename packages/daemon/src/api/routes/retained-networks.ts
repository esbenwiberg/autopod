import { AuthError } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  planRetainedNetworkReleases,
  releaseRetainedNetworks,
} from '../../containers/retained-network-release.js';

const releaseSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict();

/**
 * Operator release protocol for superseded retained bridges (#565). User Bearer
 * auth only. GET is a read-only plan; POST removes eligible empty bridges after
 * durable release records. Containers, mounts, source and reports are untouched.
 */
export function retainedNetworkRoutes(
  app: FastifyInstance,
  deps: { docker: Dockerode; db: Database.Database },
): void {
  app.get('/maintenance/retained-networks', async () => {
    const candidates = await planRetainedNetworkReleases(deps);
    return { eligible: candidates.filter((c) => c.eligible).length, candidates };
  });

  app.post('/maintenance/retained-networks/release', async (request) => {
    if (!request.user?.oid?.trim()) throw new AuthError('Authenticated human identity required');
    const { limit } = releaseSchema.parse(request.body ?? {});
    const results = await releaseRetainedNetworks(deps, {
      limit,
      actor: { type: 'human', userId: request.user.oid },
    });
    return {
      released: results.filter((r) => r.outcome === 'removed' || r.outcome === 'already_absent')
        .length,
      results,
    };
  });
}
