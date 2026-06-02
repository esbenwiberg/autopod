import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ScheduledJobManager } from '../../scheduled-jobs/scheduled-job-manager.js';

const createSchema = z.object({
  templateId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  profileName: z.string().min(1),
  task: z.string().min(1).optional(),
  cronExpression: z.string().min(1),
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  templateId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  profileName: z.string().min(1).optional(),
  cronExpression: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

const createTemplateSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
});

export function scheduledJobRoutes(
  app: FastifyInstance,
  scheduledJobManager: ScheduledJobManager,
): void {
  // POST /scheduled-job-templates — create a reusable scheduled job prompt
  app.post('/scheduled-job-templates', async (request, reply) => {
    const body = createTemplateSchema.parse(request.body);
    const template = scheduledJobManager.createTemplate(body);
    reply.status(201);
    return template;
  });

  // GET /scheduled-job-templates — list reusable scheduled job prompts
  app.get('/scheduled-job-templates', async () => {
    return scheduledJobManager.listTemplates();
  });

  // GET /scheduled-job-templates/:id — get one reusable scheduled job prompt
  app.get('/scheduled-job-templates/:id', async (request) => {
    const { id } = request.params as { id: string };
    return scheduledJobManager.getTemplate(id);
  });

  // PUT /scheduled-job-templates/:id — update a reusable scheduled job prompt
  app.put('/scheduled-job-templates/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = updateTemplateSchema.parse(request.body);
    return scheduledJobManager.updateTemplate(id, body);
  });

  // DELETE /scheduled-job-templates/:id — delete if no jobs use it
  app.delete('/scheduled-job-templates/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    scheduledJobManager.deleteTemplate(id);
    reply.status(204);
  });

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
    const pod = await scheduledJobManager.runCatchup(id);
    reply.status(201);
    return pod;
  });

  // DELETE /scheduled-jobs/:id/catchup — skip missed job
  app.delete('/scheduled-jobs/:id/catchup', async (request, reply) => {
    const { id } = request.params as { id: string };
    scheduledJobManager.skipCatchup(id);
    reply.status(204);
  });

  // POST /scheduled-jobs/:id/trigger — fire a pod immediately (ignores schedule)
  app.post('/scheduled-jobs/:id/trigger', async (request, reply) => {
    const { id } = request.params as { id: string };
    const pod = await scheduledJobManager.trigger(id);
    reply.status(201);
    return pod;
  });
}
