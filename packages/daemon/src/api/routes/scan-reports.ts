import { AuthError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ScanOperatorService } from '../../scheduled-jobs/scan-operator-service.js';

const triageSchema = z
  .object({
    requestKey: z.string().min(1).max(200),
    findingIds: z.array(z.string().min(1).max(200)).min(1).max(100),
    action: z.enum(['defer', 'resolve', 'select_repair']),
    reason: z.string().trim().min(1).max(4000),
  })
  .strict();

/** Default user Bearer auth only. Pod/MCP tokens cannot record human decisions. */
export function scanReportRoutes(app: FastifyInstance, scans: ScanOperatorService): void {
  app.get('/scheduled-jobs/:id/reports', async (request) =>
    scans.list((request.params as { id: string }).id),
  );
  app.get('/scheduled-jobs/:id/report-page', async (request) => {
    const query = z.object({ before: z.string().uuid().optional() }).strict().parse(request.query);
    return scans.page((request.params as { id: string }).id, query.before);
  });
  app.get('/scan-reports/:id', async (request) =>
    scans.detail((request.params as { id: string }).id),
  );
  app.get('/scan-reports/:id/review', async (request) =>
    scans.review((request.params as { id: string }).id),
  );
  app.get('/scan-reports/:id/findings', async (request) => {
    const query = z
      .object({ after: z.string().min(1).max(200).optional() })
      .strict()
      .parse(request.query);
    return scans.findings((request.params as { id: string }).id, query.after);
  });
  app.get('/scan-reports/:id/decisions', async (request) => {
    const query = z.object({ before: z.string().uuid().optional() }).strict().parse(request.query);
    return scans.decisions((request.params as { id: string }).id, query.before);
  });
  app.post('/scan-reports/:id/triage', async (request, reply) => {
    if (!request.user?.oid) throw new AuthError('Authenticated human identity required');
    const input = triageSchema.parse(request.body);
    const result = scans.triage({
      ...input,
      reportId: (request.params as { id: string }).id,
      actor: {
        type: 'human',
        userId: request.user.oid,
        ...(request.user.name ? { displayName: request.user.name } : {}),
      },
    });
    reply.code(201);
    return result;
  });
  app.post('/scan-reports/:id/repairs', async (request, reply) => {
    if (!request.user?.oid) throw new AuthError('Authenticated human identity required');
    const { selectionId } = z
      .object({ selectionId: z.string().uuid() })
      .strict()
      .parse(request.body);
    const result = scans.launch((request.params as { id: string }).id, selectionId);
    reply.code(201);
    return result;
  });
}
