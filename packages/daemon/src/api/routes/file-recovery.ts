import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { safeRecoveryPath } from '../../interfaces/recovery-files.js';
import type { PodManager } from '../../pods/pod-manager.js';

export function fileRecoveryRoutes(
  app: FastifyInstance,
  manager: Pick<PodManager, 'getRecoveryFiles' | 'readRecoveryFile'>,
) {
  const params = z.object({ podId: z.string().min(1).max(128) });
  const hash = z.string().regex(/^[a-f0-9]{64}$/);
  const human = (oid?: string) => {
    if (!oid) throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
  };
  app.get('/pods/:podId/file-recovery', async (request, reply) => {
    human(request.user?.oid);
    reply.header('Cache-Control', 'no-store');
    const { original } = z
      .object({ original: z.literal('1').optional() })
      .strict()
      .parse(request.query);
    return manager.getRecoveryFiles(params.parse(request.params).podId, original === '1');
  });
  app.get('/pods/:podId/file-recovery/content', async (request, reply) => {
    human(request.user?.oid);
    const selection = z
      .object({
        sourceId: z.enum(['saved-artifacts', 'saved-workspace', 'original']),
        binding: hash,
        generation: z.coerce.number().int().min(0),
        path: z.string().refine(safeRecoveryPath),
        version: hash,
      })
      .strict()
      .parse(request.query);
    reply.header('Cache-Control', 'no-store');
    return manager.readRecoveryFile(params.parse(request.params).podId, selection);
  });
}
