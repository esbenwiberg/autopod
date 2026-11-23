import { AsyncLocalStorage } from 'node:async_hooks';
import type { ScopedPodTools } from '@autopod/escalation-mcp';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { tryOperatorDaemonOwner } from './local-recovery-claim.js';
import { readParentFamily } from './parent-family-read.js';
import { ParentReviewHandoff, registerParentReviewRoutes } from './parent-review-handoff.js';
import type { composeSavedDelegationPilot } from './saved-delegation-pilot.js';
import { delegationOwnerDigest } from './saved-delegation-policy.js';

type Pilot = Awaited<ReturnType<typeof composeSavedDelegationPilot>>;
type PilotRuntime = Awaited<ReturnType<Pilot['attach']>>;

/** Own the saved lane's startup/recovery lifetime and bridge. No generic pod
 * can authorize a saved operation, even if it knows the other Task ID. */
export function createSavedDelegationRegistry(
  db: Database.Database,
  pilot: Pick<Pilot, 'principal' | 'attach' | 'advertise' | 'stopAdvertising'>,
  logger: Logger,
  lifetimeOwner?: { owns: (candidate: Database.Database) => boolean },
) {
  const attached = new Map<string, Promise<PilotRuntime>>();
  const ingress = new AsyncLocalStorage<{ podId: string; token: string } | undefined>();
  const ownerDigest = delegationOwnerDigest(pilot.principal);
  const bound = db.prepare(`SELECT a.run_id,a.owner_digest FROM saved_delegation_admissions a
    JOIN parent_managed_runs p ON p.run_id=a.run_id WHERE p.pod_id=?`);
  const binding = (podId: string) =>
    bound.get(podId) as { run_id: string; owner_digest: string } | undefined;
  const review = new ParentReviewHandoff(db);
  let timer: ReturnType<typeof setInterval> | undefined;
  let release: (() => void) | null = null;
  let stopping: Promise<void> | undefined;
  let started = false;
  function attach(podId: string) {
    if (!release || stopping || binding(podId)?.owner_digest !== ownerDigest)
      throw new Error('saved-delegation-runtime-not-ready');
    const current = attached.get(podId);
    if (current) return current;
    const pending = pilot.attach(podId);
    attached.set(podId, pending);
    pending.catch(() => {
      if (attached.get(podId) === pending) attached.delete(podId);
    });
    return pending;
  }
  async function close() {
    if (stopping) return stopping;
    started = false;
    pilot.stopAdvertising();
    if (timer) clearInterval(timer);
    stopping = Promise.allSettled(
      [...attached.values()].map(async (pending) => (await pending).close()),
    ).then(() => {
      attached.clear();
      release?.();
      release = null;
    });
    return stopping;
  }
  function authorizedOwner(
    podId: string,
    actor: { oid: string; iss: string; aud: string; operatorPrincipal?: string } | undefined,
  ) {
    const row = binding(podId);
    if (
      !row ||
      row.owner_digest !== ownerDigest ||
      actor?.operatorPrincipal !== 'delegated-user' ||
      actor.oid !== pilot.principal.oid ||
      actor.iss !== pilot.principal.iss ||
      actor.aud !== pilot.principal.aud
    )
      return null;
    return { run: row.run_id, podId, actorDigest: ownerDigest };
  }
  return {
    owns: (podId: string) => !!binding(podId),
    async start() {
      if (release || stopping) throw new Error('saved-delegation-registry-already-started');
      if (lifetimeOwner) {
        if (!lifetimeOwner.owns(db)) throw new Error('saved-delegation-registry-owner-invalid');
        // Index already holds the daemon-wide lock.
        release = () => {};
      } else {
        release = tryOperatorDaemonOwner(db);
        if (!release) throw new Error('saved-delegation-registry-owner-active');
      }
      try {
        const rows = db
          .prepare(`SELECT p.pod_id FROM saved_delegation_admissions a
          JOIN parent_managed_runs p ON p.run_id=a.run_id JOIN orchestration_runs r ON r.id=a.run_id
          WHERE r.canceled=0 OR EXISTS (SELECT 1 FROM managed_pods m WHERE m.dispatcher_installation_id='native.'||r.id AND m.observed_exit=0)
          ORDER BY p.rowid`)
          .all() as { pod_id: string }[];
        for (const { pod_id } of rows) await attach(pod_id);
        pilot.advertise();
        started = true;
        timer = setInterval(() => {
          for (const runtime of attached.values()) {
            void runtime
              .then((value) => value.tick())
              .catch(() => logger.warn('Saved delegation watchdog tick failed'));
          }
        }, 1000);
        timer.unref();
      } catch (error) {
        await close();
        throw error;
      }
    },
    close,
    async materialize(podId: string, generation: number) {
      if (!started) throw new Error('saved-delegation-runtime-not-ready');
      return (await attach(podId)).materializeParent(generation);
    },
    async provision(podId: string) {
      if (!started) throw new Error('saved-delegation-runtime-not-ready');
      return (await attach(podId)).provision();
    },
    withIngress(podId: string, token: string | undefined, use: () => Promise<void>) {
      return ingress.run(token && binding(podId) ? { podId, token } : undefined, use);
    },
    tools(podId: string): ScopedPodTools | undefined {
      const row = binding(podId);
      if (!row) return undefined;
      const active = async () => {
        const scope = ingress.getStore();
        if (!scope || scope.podId !== podId || !started || stopping)
          throw new Error('parent-session-required');
        const pending = attached.get(podId);
        if (!pending) throw new Error('saved-delegation-runtime-not-ready');
        const runtime = await pending;
        if (runtime.authorizeAttempt(scope.token) !== row.run_id)
          throw new Error('parent-session-stale');
        return { runtime, token: scope.token };
      };
      const family = () => readParentFamily(db, podId, row.run_id);
      return {
        async managedChildRequest(input) {
          const { runtime, token } = await active();
          await runtime.commission(token, input);
          await runtime.tick();
          runtime.authorizeAttempt(token);
          return family();
        },
        async managedFamily() {
          await active();
          return family();
        },
        async managedResults(input) {
          const { runtime, token } = await active();
          return runtime.results(token, input);
        },
        async managedWait(input) {
          const { runtime, token } = await active();
          return runtime.wait(token, input);
        },
      };
    },
    registerFamily(app: FastifyInstance) {
      app.get('/orchestration/parents/:podId/family', async (request, reply) => {
        reply.header('cache-control', 'no-store');
        const { podId } = request.params as { podId: string };
        const owner = authorizedOwner(podId, request.user);
        if (!owner) return reply.code(404).send({ code: 'parent-family-not-found' });
        return {
          ...readParentFamily(db, podId, owner.run, true),
          review: review.familyReview(owner, true),
        };
      });
      registerParentReviewRoutes(app, review, async (request, podId) =>
        authorizedOwner(podId, request.user),
      );
    },
  };
}
