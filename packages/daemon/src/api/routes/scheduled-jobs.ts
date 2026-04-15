import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ScheduledJobManager } from '../../scheduled-jobs/scheduled-job-manager.js';

const createSchema = z.object({
  name: z.string().min(1),
  profileName: z.string().min(1),
  task: z.string().min(1),
  cronExpression: z.string().min(1),
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  cronExpression: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export function scheduledJobRoutes(
  app: FastifyInstance,
  scheduledJobManager: ScheduledJobManager,
): void {
  // POST /scheduled-jobs — create a scheduled job
  app.post('/scheduled-jobs', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const job = scheduledJobManager.create(body);
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
    const body = updateSchema.parse(request.body);
    return scheduledJobManager.update(id, body);
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
