import { AutopodError, type HistoryQuery } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../../sessions/index.js';

export function historyRoutes(app: FastifyInstance, sessionManager: SessionManager): void {
  // POST /sessions/history-workspace — create a workspace pod with history data
  app.post('/sessions/history-workspace', async (request, reply) => {
    const body = request.body as {
      profileName?: string;
      since?: string;
      limit?: number;
      failuresOnly?: boolean;
    };

    if (!body.profileName) {
      reply.status(400);
      return { error: 'profileName is required' };
    }

    const historyQuery: HistoryQuery = {
      profileName: body.profileName,
      since: body.since,
      limit: body.limit,
      failuresOnly: body.failuresOnly,
    };

    try {
      const session = sessionManager.createHistoryWorkspace(
        body.profileName,
        request.user.oid,
        historyQuery,
      );
      reply.status(201);
      return session;
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message };
      }
      throw err;
    }
  });
}
