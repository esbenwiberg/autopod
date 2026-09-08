import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ManagedControls } from '../../managed/managed-controls.js';
import type { ManagedPodService } from '../../managed/managed-service.js';

export interface ManagedPodApiDeps {
  service: ManagedPodService;
  finishOutputs?: () => Promise<void>;
  /** Derived from the authenticated service principal; request bodies cannot supply it. */
  authenticate: (request: FastifyRequest) => Promise<string | null>;
}
export function managedPodRoutes(app: FastifyInstance, deps: ManagedPodApiDeps): void {
  const controls = new ManagedControls(deps.service);
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void deps.service
        .enforceExpiry()
        .then(() => deps.finishOutputs?.())
        .catch(() => app.log.error('managed-watchdog-failed'))
        .finally(() => {
          ticking = false;
        });
    }, 1000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
  app.get('/managed/health', async (request, reply) => {
    if (!(await deps.authenticate(request)))
      return reply.code(401).send({ code: 'managed-auth-required' });
    return deps.service.health();
  });
  for (const operation of ['preflight', 'pods', 'reconcile-start'] as const) {
    app.post(`/managed/${operation}`, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const installation = await deps.authenticate(request);
      if (!installation)
        return reply.code(401).send({
          schemaVersion: 1,
          code: 'managed-auth-required',
          retryable: false,
          requestId: request.id,
        });
      try {
        if (operation === 'preflight') {
          await deps.service.preflight(request.body, installation);
          return { accepted: true };
        }
        if (operation === 'reconcile-start')
          return await deps.service.reconcileStart(installation, request.body);
        return await deps.service.start(installation, request.body);
      } catch {
        return reply.code(409).send({
          schemaVersion: 1,
          code: 'managed-request-rejected',
          retryable: false,
          requestId: request.id,
        });
      }
    });
  }
  app.get<{ Params: { podId: string }; Querystring: { cursor?: string } }>(
    '/managed/pods/:podId/events',
    async (request, reply) => {
      const installation = await deps.authenticate(request);
      if (!installation) return reply.code(401).send({ code: 'managed-auth-required' });
      try {
        return controls.observe(installation, request.params.podId, request.query.cursor ?? '0');
      } catch {
        return reply.code(409).send({
          schemaVersion: 1,
          code: 'managed-observation-rejected',
          retryable: false,
          requestId: request.id,
        });
      }
    },
  );
  app.get<{ Params: { podId: string } }>(
    '/managed/pods/:podId/candidate/bundle',
    async (request, reply) => {
      const installation = await deps.authenticate(request);
      if (!installation) return reply.code(401).send({ code: 'managed-auth-required' });
      try {
        if (!deps.service.source) throw new Error('source-unavailable');
        const value = deps.service.source.candidate(installation, request.params.podId);
        return reply.type('application/octet-stream').send(value.bundle);
      } catch {
        return reply.code(409).send({ code: 'source-candidate-unavailable' });
      }
    },
  );
  app.post<{ Params: { podId: string } }>(
    '/managed/pods/:podId/finalize',
    { bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const installation = await deps.authenticate(request);
      if (!installation) return reply.code(401).send({ code: 'managed-auth-required' });
      try {
        if (!deps.service.source) throw new Error('source-unavailable');
        return await deps.service.source.finalize(installation, request.params.podId, request.body);
      } catch {
        return reply.code(409).send({ code: 'source-finalize-rejected' });
      }
    },
  );
  for (const operation of ['control', 'send', 'grant'] as const) {
    app.post<{ Params: { podId: string; key: string } }>(
      `/managed/pods/:podId/${operation}/:key`,
      { bodyLimit: 1024 * 1024 },
      async (request, reply) => {
        const installation = await deps.authenticate(request);
        if (!installation) return reply.code(401).send({ code: 'managed-auth-required' });
        try {
          if (operation === 'grant') {
            controls.updateGrant(installation, request.params.podId, request.body);
            return { accepted: true };
          }
          return await controls[operation](
            installation,
            request.params.podId,
            request.body,
            request.params.key,
          );
        } catch {
          return reply.code(409).send({
            schemaVersion: 1,
            code: 'managed-control-rejected',
            retryable: false,
            requestId: request.id,
          });
        }
      },
    );
  }
}
