import type {
  MemoryCandidate,
  MemoryCandidateStatus,
  MemoryKind,
  MemoryScope,
  MemorySourceEvidence,
} from '@autopod/shared';
import { generateId } from '@autopod/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MemoryCandidateRepository } from '../../pods/memory-candidate-repository.js';
import type { MemoryExtractionAttemptRepository } from '../../pods/memory-extraction-attempt-repository.js';
import type { MemoryRepository } from '../../pods/memory-repository.js';
import type { MemoryUsageRepository } from '../../pods/memory-usage-repository.js';

export interface MemoryDeps {
  memoryRepo: MemoryRepository;
  memoryCandidateRepo?: MemoryCandidateRepository;
  memoryExtractionAttemptRepo?: MemoryExtractionAttemptRepository;
  memoryUsageRepo?: MemoryUsageRepository;
}

type CandidateEditableFields = Pick<
  MemoryCandidate,
  | 'path'
  | 'content'
  | 'rationale'
  | 'kind'
  | 'tags'
  | 'appliesWhen'
  | 'avoidWhen'
  | 'confidence'
  | 'sourceEvidence'
  | 'impactSummary'
>;

type CandidatePatchBody = Partial<
  Omit<CandidateEditableFields, 'kind' | 'sourceEvidence'> & {
    kind: MemoryKind;
    sourceEvidence: MemorySourceEvidence[];
  }
> & {
  action?: 'approve' | 'reject' | 'update';
};

export function memoryRoutes(app: FastifyInstance, deps: MemoryDeps): void {
  const { memoryRepo, memoryCandidateRepo, memoryExtractionAttemptRepo, memoryUsageRepo } = deps;

  function candidateRepoOr503(reply: FastifyReply) {
    if (memoryCandidateRepo) return memoryCandidateRepo;
    reply.status(503).send({ error: 'Memory candidates unavailable — repository not wired' });
    return null;
  }

  // GET /memory?scope=&scopeId=&approved=
  // When scopeId is omitted, returns ALL entries for that scope (no scope_id filter).
  // When scopeId is present (even empty string), filters to that specific scope_id.
  app.get('/memory', async (request, reply) => {
    const q = request.query as {
      scope?: string;
      scopeId?: string;
      approved?: string;
    };
    const scope = (q.scope ?? 'global') as MemoryScope;
    const approvedOnly = q.approved !== 'false';
    const entries =
      q.scopeId === undefined
        ? memoryRepo.listByScope(scope, approvedOnly)
        : memoryRepo.list(scope, q.scopeId || null, approvedOnly);
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
      rationale: null,
      createdByPodId: null,
    });
    return reply.status(201).send(entry);
  });

  // GET /memory/candidates?scopeId=&status=pending|approved|rejected|all
  app.get('/memory/candidates', async (request, reply) => {
    const repo = candidateRepoOr503(reply);
    if (!repo) return;
    const q = request.query as { scopeId?: string; status?: string };
    if (!q.scopeId) {
      return reply.status(400).send({ error: 'scopeId is required' });
    }
    const status = q.status ?? 'pending';
    if (status === 'all') return repo.list(q.scopeId);
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return reply.status(400).send({
        error: 'status must be pending, approved, rejected, or all',
        code: 'invalid_status',
      });
    }
    return repo.list(q.scopeId, status as MemoryCandidateStatus);
  });

  // GET /memory/candidates/:id/source-evidence
  app.get('/memory/candidates/:id/source-evidence', async (request, reply) => {
    const repo = candidateRepoOr503(reply);
    if (!repo) return;
    const { id } = request.params as { id: string };
    const candidate = repo.get(id);
    if (!candidate) return reply.status(404).send({ error: `Memory candidate not found: ${id}` });
    return { candidateId: id, evidence: candidate.sourceEvidence };
  });

  // GET /memory/extraction-attempts?profileName=&limit=
  app.get('/memory/extraction-attempts', async (request, reply) => {
    if (!memoryExtractionAttemptRepo) {
      return reply
        .status(503)
        .send({ error: 'Memory extraction attempts unavailable — repository not wired' });
    }
    const q = request.query as { profileName?: string; limit?: string };
    if (!q.profileName) {
      return reply.status(400).send({ error: 'profileName is required' });
    }
    const limit = q.limit ? Number.parseInt(q.limit, 10) : 20;
    return memoryExtractionAttemptRepo.listByProfile(
      q.profileName,
      Number.isNaN(limit) ? 20 : limit,
    );
  });

  // PATCH /memory/candidates/:id — approve/reject/update pending durable candidates.
  app.patch('/memory/candidates/:id', async (request, reply) => {
    const repo = candidateRepoOr503(reply);
    if (!repo) return;
    const { id } = request.params as { id: string };
    const body = request.body as CandidatePatchBody;

    if (!body.action) {
      return reply.status(400).send({ error: 'action is required' });
    }

    try {
      if (body.action === 'approve') {
        return repo.approve(id, memoryRepo);
      }
      if (body.action === 'reject') {
        return repo.reject(id);
      }
      if (body.action === 'update') {
        const updates: Partial<CandidateEditableFields> = {
          ...(body.path !== undefined ? { path: body.path } : {}),
          ...(body.content !== undefined ? { content: body.content } : {}),
          ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
          ...(body.appliesWhen !== undefined ? { appliesWhen: body.appliesWhen } : {}),
          ...(body.avoidWhen !== undefined ? { avoidWhen: body.avoidWhen } : {}),
          ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
          ...(body.sourceEvidence !== undefined ? { sourceEvidence: body.sourceEvidence } : {}),
          ...(body.impactSummary !== undefined ? { impactSummary: body.impactSummary } : {}),
        };
        if (Object.keys(updates).length === 0) {
          return reply.status(400).send({ error: 'at least one editable field is required' });
        }
        return repo.update(id, updates);
      }
      return reply.status(400).send({ error: 'action must be approve, reject, or update' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Memory candidate operation failed';
      const status = message.includes('not found') ? 404 : 400;
      return reply.status(status).send({ error: message });
    }
  });

  // GET /memory/:id/usage — per-memory usage history.
  app.get('/memory/:id/usage', async (request, reply) => {
    if (!memoryUsageRepo) {
      return reply.status(503).send({ error: 'Memory usage unavailable — repository not wired' });
    }
    const { id } = request.params as { id: string };
    try {
      memoryRepo.getOrThrow(id);
    } catch {
      return reply.status(404).send({ error: `Memory entry not found: ${id}` });
    }
    return { memoryId: id, events: memoryUsageRepo.listByMemory(id) };
  });

  // GET /memory/:id/source-evidence
  app.get('/memory/:id/source-evidence', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const memory = memoryRepo.getOrThrow(id);
      return { memoryId: id, evidence: memory.sourceEvidence };
    } catch {
      return reply.status(404).send({ error: `Memory entry not found: ${id}` });
    }
  });

  async function harmfulStaleEvidence(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) {
    if (!memoryUsageRepo) {
      return reply.status(503).send({ error: 'Memory usage unavailable — repository not wired' });
    }
    const { id } = request.params;
    try {
      memoryRepo.getOrThrow(id);
    } catch {
      return reply.status(404).send({ error: `Memory entry not found: ${id}` });
    }
    const events = memoryUsageRepo
      .listByMemory(id)
      .filter((event) => event.outcome === 'harmful_stale');
    return { memoryId: id, evidence: events };
  }

  // Evidence only: v1 does not auto-disable stale/harmful memories.
  app.get('/memory/:id/stale-evidence', harmfulStaleEvidence);
  app.get('/memory/:id/harmful-evidence', harmfulStaleEvidence);

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
