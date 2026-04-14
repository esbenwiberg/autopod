import type { CreateScheduledJobRequest, UpdateScheduledJobRequest } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { ScheduledJobManager } from '../../scheduled-jobs/scheduled-job-manager.js';

export function scheduledJobRoutes(
  app: FastifyInstance,
  scheduledJobManager: ScheduledJobManager,
): void {
  // POST /scheduled-jobs — create a scheduled job
  app.post('/scheduled-jobs', async (request, reply) => {
    const job = scheduledJobManager.create(request.body as CreateScheduledJobRequest);
    reply.status(201);
    return job;
  });

  // GET /scheduled-jobs — list all scheduled jobs
  app.get('/scheduled-jobs', async () => {
    return scheduledJobManager.list();
  });

  // GET /scheduled-jobs/:id — get a scheduled job
  app.get('/scheduled-jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    return scheduledJobManager.get(id);
  });

  // PUT /scheduled-jobs/:id — update a scheduled job
  app.put('/scheduled-jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    return scheduledJobManager.update(id, request.body as UpdateScheduledJobRequest);
  });

  // DELETE /scheduled-jobs/:id — delete a scheduled job
  app.delete('/scheduled-jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    scheduledJobManager.delete(id);
    reply.status(204);
  });

  // POST /scheduled-jobs/:id/catchup — run missed job now
  app.post('/scheduled-jobs/:id/catchup', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await scheduledJobManager.runCatchup(id);
    reply.status(201);
    return session;
  });

  // DELETE /scheduled-jobs/:id/catchup — skip missed job
  app.delete('/scheduled-jobs/:id/catchup', async (request, reply) => {
    const { id } = request.params as { id: string };
    scheduledJobManager.skipCatchup(id);
    reply.status(204);
  });

  // POST /scheduled-jobs/:id/trigger — fire a session immediately (ignores schedule)
  app.post('/scheduled-jobs/:id/trigger', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await scheduledJobManager.trigger(id);
    reply.status(201);
    return session;
  });
}
