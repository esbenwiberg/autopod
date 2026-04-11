import type { MemoryScope } from '@autopod/shared';
import { generateId } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { MemoryRepository } from '../../sessions/memory-repository.js';

export interface MemoryDeps {
  memoryRepo: MemoryRepository;
}

export function memoryRoutes(app: FastifyInstance, deps: MemoryDeps): void {
  const { memoryRepo } = deps;

  // GET /memory?scope=&scopeId=&approved=
  app.get('/memory', async (request, reply) => {
    const q = request.query as {
      scope?: string;
      scopeId?: string;
      approved?: string;
    };
    const scope = (q.scope ?? 'global') as MemoryScope;
    const scopeId = q.scopeId ?? null;
    const approvedOnly = q.approved !== 'false';
    const entries = memoryRepo.list(scope, scopeId, approvedOnly);
    return reply.send(entries);
  });

  // POST /memory — create (human-created, auto-approved)
  app.post('/memory', async (request, reply) => {
    const body = request.body as {
      scope: MemoryScope;
      scopeId?: string | null;
      path: string;
      content: string;
    };
    if (!body.scope || !body.path || !body.content) {
      return reply.status(400).send({ error: 'scope, path and content are required' });
    }
    const entry = memoryRepo.insert({
      id: generateId(8),
      scope: body.scope,
      scopeId: body.scopeId ?? null,
      path: body.path,
      content: body.content,
      approved: true,
      createdBySessionId: null,
    });
    return reply.status(201).send(entry);
  });

  // PATCH /memory/:id
  app.patch('/memory/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { action: 'approve' | 'reject' | 'update'; content?: string };

    if (!body.action) {
      return reply.status(400).send({ error: 'action is required' });
    }

    if (body.action === 'approve') {
      memoryRepo.approve(id);
    } else if (body.action === 'reject') {
      memoryRepo.reject(id);
    } else if (body.action === 'update') {
      if (!body.content) return reply.status(400).send({ error: 'content required for update' });
      memoryRepo.update(id, body.content);
    } else {
      return reply.status(400).send({ error: 'action must be approve, reject, or update' });
    }

    return reply.status(204).send();
  });

  // DELETE /memory/:id
  app.delete('/memory/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    memoryRepo.delete(id);
    return reply.status(204).send();
  });
}
