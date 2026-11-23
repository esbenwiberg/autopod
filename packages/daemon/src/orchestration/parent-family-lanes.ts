import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthModule } from '../interfaces/auth-module.js';
import {
  ParentReviewHandoff,
  type ParentReviewOwner,
  registerParentReviewRoutes,
} from './parent-review-handoff.js';

type FamilyResult = { body: unknown } | { status: 401 | 404; code: string };
export interface ParentFamilyAccess {
  family(request: FastifyRequest, podId: string): Promise<FamilyResult>;
  authorizeReview(request: FastifyRequest, podId: string): Promise<ParentReviewOwner | null>;
}
interface ParentLane {
  owns(podId: string): boolean;
  withIngress(podId: string, token: string | undefined, run: () => Promise<void>): Promise<void>;
  familyAccess(auth: AuthModule): ParentFamilyAccess;
}

export function registerParentFamilySurface(
  app: FastifyInstance,
  db: Database.Database,
  laneFor: (podId: string) => ParentFamilyAccess | undefined,
) {
  app.get('/orchestration/parents/:podId/family', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { podId } = request.params as { podId: string };
    const result = await laneFor(podId)?.family(request, podId);
    if (!result) return reply.code(404).send({ code: 'parent-family-not-found' });
    if ('status' in result) return reply.code(result.status).send({ code: result.code });
    return result.body;
  });
  registerParentReviewRoutes(
    app,
    new ParentReviewHandoff(db),
    async (request, podId) => (await laneFor(podId)?.authorizeReview(request, podId)) ?? null,
  );
}

/** Select the durable owner before authentication or ingress. No fallback when
 * that lane denies the actor or attempt, and never mount duplicate HTTP routes. */
export function combineParentLanes(db: Database.Database, signed: ParentLane, saved: ParentLane) {
  const pick = (podId: string) => {
    const a = signed.owns(podId);
    const b = saved.owns(podId);
    if (a && b) throw new Error('parent-lane-ownership-overlap');
    return a ? signed : b ? saved : undefined;
  };
  return {
    withIngress(podId: string, token: string | undefined, run: () => Promise<void>) {
      return pick(podId)?.withIngress(podId, token, run) ?? run();
    },
    registerFamily(app: FastifyInstance, auth: AuthModule) {
      const signedAccess = signed.familyAccess(auth);
      const savedAccess = saved.familyAccess(auth);
      registerParentFamilySurface(app, db, (podId) => {
        const lane = pick(podId);
        return lane === signed ? signedAccess : lane === saved ? savedAccess : undefined;
      });
    },
  };
}
